/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The GC must actually be ARMED by the entrypoint.
 *
 * #2790 happened because a needed sweep existed nowhere; a sweep that is
 * written but never wired looks identical from the outside. So these test the
 * exported wiring `bin.ts` itself calls, not a worker the test constructs.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RoomManager } from '../src/room-manager.js';
import { MemoryPersistence } from '../src/persistence.js';
import { FsBlobStorage } from '../src/blob-route.js';
import { resolveBlobGcConfig, startBlobGc } from '../src/blob-gc.js';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wire-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('blob gc wiring', () => {
  it('is enabled by default', () => {
    // An operator who sets nothing must still be protected: blobs are never
    // otherwise deleted.
    expect(resolveBlobGcConfig({}).enabled).toBe(true);
  });

  it('is disabled by COLLAB_BLOB_GC=0 or =false', () => {
    expect(resolveBlobGcConfig({ COLLAB_BLOB_GC: '0' }).enabled).toBe(false);
    expect(resolveBlobGcConfig({ COLLAB_BLOB_GC: 'false' }).enabled).toBe(false);
  });

  it('reads the interval and grace overrides', () => {
    const c = resolveBlobGcConfig({
      COLLAB_BLOB_GC_INTERVAL_MS: '1000',
      COLLAB_BLOB_GC_GRACE_MS: '2000',
    });
    expect(c.intervalMs).toBe(1000);
    expect(c.graceMs).toBe(2000);
  });

  it('startBlobGc arms a worker when enabled and none when disabled', () => {
    const dataDir = tmp();
    const roomManager = new RoomManager({ persistence: new MemoryPersistence() });
    const storage = new FsBlobStorage(dataDir);

    const off = startBlobGc({
      dataDir,
      storage,
      roomManager,
      config: { enabled: false, intervalMs: 1000, graceMs: 1000 },
    });
    expect(off).toBeNull();

    const on = startBlobGc({
      dataDir,
      storage,
      roomManager,
      config: { enabled: true, intervalMs: 60_000, graceMs: 1000 },
    });
    expect(on).not.toBeNull();
    on?.stop();
  });

  it('the entrypoint actually arms it', () => {
    // The tests above all pass if `bin.ts` never calls this wiring, which is
    // precisely the #2790 failure: mechanism present, never run. A unit test
    // cannot observe that, and importing bin.ts to check would start a real
    // server (it calls main() at module load, and guarding that on argv[1]
    // would break the npm-bin symlink case). So assert on the source.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'bin.ts'),
      'utf8',
    );
    expect(src).toMatch(/startBlobGc\(/);
    expect(src).toMatch(/resolveBlobGcConfig\(/);
    expect(src, 'the worker must be stopped on shutdown').toMatch(/blobGc\?\.stop\(\)/);
    expect(src, 'startup line must report gc state so a dead sweep is visible').toMatch(
      /blob-gc:/,
    );
  });
});
