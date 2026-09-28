/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FsBlobStorage` initialization failures (#6286).
 *
 * The constructor starts creating `<dataDir>/blobs`. If that fails before any
 * method awaits it, the rejection must not surface as an unhandled rejection
 * (it failed an otherwise green Vitest run), yet every method must still see
 * the error rather than silently operating on a missing directory.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsBlobStorage } from '../src/blob-storage-fs.js';

const HASH = 'a'.repeat(32);
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('FsBlobStorage initialization (#6286)', () => {
  it('a failed constructor mkdir is not an unhandled rejection', async () => {
    const error = Object.assign(new Error('ENOENT: no such file or directory, mkdir'), {
      code: 'ENOENT',
    });
    // An already-rejected promise, so the outcome does not depend on how long
    // a real mkdir takes.
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValueOnce(error);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const storage = new FsBlobStorage('/unused');
      // Node reports unhandled rejections once the microtask queue drains,
      // which is before the event loop reaches the check phase.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);

      // Observing the failure must not swallow it: callers still get it.
      await expect(storage.whenReady()).rejects.toBe(error);
      await expect(storage.list()).rejects.toBe(error);
      await expect(storage.put(HASH, new Uint8Array([1]))).rejects.toBe(error);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('surfaces a real mkdir failure through whenReady and every method', async () => {
    // `dataDir` is a regular file, so `<dataDir>/blobs` cannot be created.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-fs-init-'));
    dirs.push(dir);
    const dataDir = path.join(dir, 'not-a-dir');
    fs.writeFileSync(dataDir, 'x');

    const storage = new FsBlobStorage(dataDir);
    await expect(storage.whenReady()).rejects.toMatchObject({ code: 'ENOTDIR' });
    await expect(storage.get(HASH)).rejects.toMatchObject({ code: 'ENOTDIR' });
    await expect(storage.has(HASH)).rejects.toMatchObject({ code: 'ENOTDIR' });
    await expect(storage.delete(HASH)).rejects.toMatchObject({ code: 'ENOTDIR' });
    await expect(storage.deleteIfOlderThan(HASH, Date.now())).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });

  it('whenReady resolves once the blobs directory exists', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-fs-init-'));
    dirs.push(dataDir);
    const storage = new FsBlobStorage(dataDir);
    await storage.whenReady();
    expect(fs.statSync(path.join(dataDir, 'blobs')).isDirectory()).toBe(true);
  });
});
