/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// fake-indexeddb installs a Node-compatible IDB implementation on
// `globalThis.indexedDB` when imported via the `/auto` entry point.
import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { InstalledExtensionRecord } from '@ifc-lite/extensions';
import { ExtensionStorageQuotaError, IdbExtensionStorage } from './idb-storage.js';

function record(id: string): InstalledExtensionRecord {
  return {
    id,
    name: id,
    version: '1.0.0',
    manifestVersion: 1,
    installedAt: '2026-01-01T00:00:00Z',
  } as unknown as InstalledExtensionRecord;
}

describe('IdbExtensionStorage', () => {
  let storage: IdbExtensionStorage;

  beforeEach(async () => {
    storage = new IdbExtensionStorage();
    await storage.clear();
  });

  describe('deleteExtension cascade', () => {
    it('deletes only bundles belonging to the deleted extension, by prefix key, not by substring', async () => {
      // "a" and "ab" share a common prefix; a naive substring match on the
      // bundle key ("ab@1.0.0".includes("a")) would wrongly delete "ab"'s
      // bundle when deleting "a". The real key format is `<id>@<version>`,
      // so the correct boundary is the "@" separator.
      await storage.putExtension(record('a'));
      await storage.putExtension(record('ab'));
      await storage.putBundle('a', '1.0.0', new Uint8Array([1]));
      await storage.putBundle('ab', '1.0.0', new Uint8Array([2]));

      await storage.deleteExtension('a');

      const deleted = await storage.getBundle('a', '1.0.0');
      const survivor = await storage.getBundle('ab', '1.0.0');
      assert.equal(deleted, undefined, 'bundle for the deleted extension must be gone');
      assert.deepStrictEqual(
        survivor,
        new Uint8Array([2]),
        'an unrelated extension sharing a name prefix must survive',
      );
    });

    it('deletes the extension record itself', async () => {
      await storage.putExtension(record('solo'));
      await storage.deleteExtension('solo');
      const got = await storage.getExtension('solo');
      assert.equal(got, undefined);
    });
  });

  describe('quota handling', () => {
    it('wraps a QuotaExceededError from putExtension in ExtensionStorageQuotaError', async () => {
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function quotaPut(): never {
        throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      };
      try {
        await assert.rejects(
          () => storage.putExtension(record('q')),
          (err: unknown) => err instanceof ExtensionStorageQuotaError,
        );
      } finally {
        IDBObjectStore.prototype.put = originalPut;
      }
    });

    it('wraps a QuotaExceededError from putBundle in ExtensionStorageQuotaError', async () => {
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function quotaPut(): never {
        throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      };
      try {
        await assert.rejects(
          () => storage.putBundle('q', '1.0.0', new Uint8Array([9])),
          (err: unknown) => err instanceof ExtensionStorageQuotaError,
        );
      } finally {
        IDBObjectStore.prototype.put = originalPut;
      }
    });

    it('does not wrap a non-quota error — it must propagate as-is', async () => {
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function boomPut(): never {
        throw new Error('disk read-only');
      };
      try {
        await assert.rejects(
          () => storage.putExtension(record('e')),
          (err: unknown) => !(err instanceof ExtensionStorageQuotaError) && (err as Error).message === 'disk read-only',
        );
      } finally {
        IDBObjectStore.prototype.put = originalPut;
      }
    });
  });

  describe('clear', () => {
    it('empties both stores', async () => {
      await storage.putExtension(record('x'));
      await storage.putBundle('x', '1.0.0', new Uint8Array([1]));
      await storage.clear();
      assert.deepStrictEqual(await storage.listExtensions(), []);
      assert.equal(await storage.getBundle('x', '1.0.0'), undefined);
    });
  });
});
