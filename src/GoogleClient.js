/*
 * Copyright 2021 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { google } from 'googleapis';
import {
  editDistance, sanitizeName, splitByExtension,
} from '@adobe/helix-onedrive-support/utils';
import { StatusCodeError } from '@adobe/helix-onedrive-support';
import { GoogleTokenCache } from './GoogleTokenCache.js';
import cache from './cache.js';

/**
 * @typedef DriveItemInfo {
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {string} path
 */

/**
 * Adds the last modified property if defined in item
 * @param {DriveItemInfo} itemInfo
 * @param item
 * @returns {DriveItemInfo}
 */
function addLastModified(itemInfo, item) {
  if (item.modifiedTime) {
    // eslint-disable-next-line no-param-reassign
    itemInfo.lastModified = Date.parse(item.modifiedTime);
  }
  return itemInfo;
}

/**
 * Google auth client
 */
export class GoogleClient {
  /**
   * Sets the global item cache options. It internally creates a new LRU
   * with the given options
   *
   * @param opts
   */
  static setItemCacheOptions(opts) {
    cache.options(opts);
  }

  /**
   * Returns a url for a google drive id.
   * @param {string} id
   * @returns {string}
   */
  static id2Url(id) {
    if (!id || id.startsWith('gdrive:')) {
      return id;
    }
    return `gdrive:${id}`;
  }

  /**
   *
   * @param {ICachePlugin} plugin
   */
  constructor(opts) {
    Object.assign(this, {
      log: opts.log,
      auth: new google.auth.OAuth2(
        opts.clientId,
        opts.clientSecret,
        opts.redirectUri,
      ),
    });

    if (opts.cachePlugin) {
      this.cachePlugin = opts.cachePlugin;
      this.cache = new GoogleTokenCache(opts.cachePlugin).withLog(opts.log);
      /// hack to capture tokens, since the emit handler is not awaited in the google client
      const originalRefreshTokenNoCache = this.auth.refreshTokenNoCache.bind(this.auth);
      this.auth.refreshTokenNoCache = async (...args) => {
        const ret = await originalRefreshTokenNoCache(...args);
        await this.cache.store(ret.tokens);
        return ret;
      };
    }

    this.drive = google.drive({
      version: 'v3',
      auth: this.auth,
    });

    /**
     * Cached version of `getUncachedItemsFromSegments`
     */
    this.getDriveItemsFromSegments = cache(this.getUncachedItemsFromSegments.bind(this), {
      hash: (fn, segs, parentId) => `${parentId}:${segs.join('/')}`,
    });
  }

  async init() {
    if (this.cache) {
      await this.cache.load();
      this.auth.setCredentials(this.cache.tokens);
    }
    return this;
  }

  async generateAuthUrl(...args) {
    return this.auth.generateAuthUrl(...args);
  }

  /**
   * Sets the credentials
   * @param tokens
   * @returns {Promise<void>}
   */
  async setCredentials(tokens) {
    if (this.cache) {
      await this.cache.store(tokens);
    }
    this.auth.setCredentials(tokens);
  }

  /**
   * Returns the token for the given code
   * @param {string} code
   * @returns {Promise<*>}
   */
  async getToken(code) {
    const { tokens } = await this.auth.getToken(code);
    if (this.cache) {
      await this.cache.store(tokens);
    }
    return tokens;
  }

  /**
   * @param {string} path
   * @param {string} parentId
   * @param {string} parentPath
   * @returns {Promise<DriveItemInfo[]>}
   */
  async getUncachedItemsFromSegments(pathSegments, parentId, parentPath) {
    const { log, drive } = this;
    const name = pathSegments.shift();
    const [baseName, ext] = splitByExtension(name);
    const sanitizedName = sanitizeName(baseName);

    const items = [];
    const opts = {
      q: [
        `'${parentId}' in parents`,
        'and trashed=false',
        // folder if path continues, sheet otherwise
        `and mimeType ${pathSegments.length ? '=' : '!='} 'application/vnd.google-apps.folder'`,
      ].join(' '),
      fields: 'nextPageToken, files(id, name, modifiedTime)',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 1000,
    };

    do {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await drive.files.list(opts);
      if (data.nextPageToken) {
        opts.pageToken = data.nextPageToken;
      } else {
        opts.pageToken = null;
      }
      log.debug(`fetched ${data.files.length} items below ${parentId}. nextPageToken=${opts.pageToken ? '****' : 'null'}`);

      // find fuzzy match
      data.files.forEach((item) => {
        const [itemName, itemExt] = splitByExtension(item.name);
        // remember extension
        // eslint-disable-next-line no-param-reassign
        item.extension = itemExt;
        /* c8 ignore next 4 */
        if (ext && ext !== itemExt) {
          // only match extension if given via relPath
          return;
        }
        const sanitizedItemName = sanitizeName(itemName);
        if (sanitizedItemName !== sanitizedName) {
          return;
        }
        // compute edit distance
        // eslint-disable-next-line no-param-reassign
        item.fuzzyDistance = editDistance(baseName, itemName);
        items.push(item);
      });
    } while (opts.pageToken);

    // sort items by edit distance first and 2nd by item name
    items.sort((i0, i1) => {
      let c = i0.fuzzyDistance - i1.fuzzyDistance;
      /* c8 ignore next 3 */
      if (c === 0) {
        c = i0.name.localeCompare(i1.name);
      }
      return c;
    });

    const [item] = items;

    if (!item) {
      return null;
    }

    const itemPath = `${parentPath}/${sanitizedName}`;
    const children = pathSegments.length
      // eslint-disable-next-line no-use-before-define
      ? await this.getDriveItemsFromSegments(pathSegments, item.id, itemPath)
      : [];

    if (!children) {
      return null;
    }

    const pathItem = addLastModified({
      name,
      path: itemPath,
      id: item.id,
    }, item);

    return [...children, pathItem];
  }

  /**
   * returns the items hierarchy for the given path and root id, starting with the given path.
   * @param path
   * @param rootId
   * @return {DriveItemInfo[]}
   */
  async getItemsFromPath(path, rootId) {
    const segs = path.split('/');
    if (!segs[0]) {
      // if path starts with '/' the first segment is empty
      segs.shift();
    }
    const result = await this.getDriveItemsFromSegments(segs, rootId, '');
    if (!result) {
      return [];
    }
    return [...result, {
      name: '',
      path: '/',
      id: rootId,
    }];
  }

  /**
   * returns the items hierarchy for the given item, starting with the given id
   * @param {string} fileId
   * @param {object} roots
   * @returns {Promise<DriveItemInfo[]>}
   */
  async getItems(fileId, roots) {
    const { log } = this;
    log.debug(`getItems(${fileId})`);
    const { data } = (await this.drive.files.get({
      fileId,
      fields: [
        'name',
        'parents',
        'modifiedTime',
      ].join(','),
    }));

    const root = roots[fileId];
    if (root) {
      // stop at mount root
      return [addLastModified({
        id: fileId,
        name: '',
        path: root,
      }, data)];
    }

    const parentId = data.parents ? data.parents[0] : '';
    if (!parentId) {
      // outside mountpoint
      return [addLastModified({
        id: fileId,
        name: data.name,
        path: `/root:/${data.name}`,
      }, data)];
    }

    const ancestors = await this.getItems(data.parents[0], roots);
    const parentPath = ancestors[0].path.replace(/\/+$/, '');
    ancestors.unshift(addLastModified({
      id: fileId,
      name: data.name,
      path: `${parentPath}/${data.name}`,
    }, data));
    return ancestors;
  }

  /**
   * @param {string} fileId
   * @param {object} roots
   * @returns {Promise<DriveItemInfo[]>}
   */
  async getItemsFromId(fileId, roots) {
    const { log } = this;
    try {
      return await this.getItems(fileId, roots);
    } catch (e) {
      if (e.response && e.response.status === 404) {
        log.warn(`unable to get items for ${fileId}. Not found`);
        return [];
      }
      log.warn(`unable to get items for ${fileId}. ${e}`);
      throw e;
    }
  }

  /**
   * @param {string} fileId
   * @returns {string} file data
   */
  async getFile(fileId) {
    try {
      const res = await this.drive.files.get({
        fileId,
        alt: 'media',
      });
      return res.data;
    } catch (e) {
      if (e.response && e.response.status === 404) {
        throw new StatusCodeError(`Not Found: ${fileId}`, 404);
      }
      throw e;
    }
  }

  async getDocument(documentId) {
    const docs = google.docs({
      version: 'v1',
      auth: this.auth,
    });
    try {
      const res = await docs.documents.get({ documentId });
      return res.data;
    } catch (e) {
      if (e.response && e.response.status === 404) {
        throw new StatusCodeError(`Not Found: ${documentId}`, 404);
      }
      throw e;
    }
  }
}
