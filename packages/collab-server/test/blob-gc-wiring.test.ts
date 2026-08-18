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
import { defaultMetrics } from '../src/metrics.js';

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

  it('rejects malformed durations instead of sweeping with them', () => {
    // Number('') is 0 and Number('abc') is NaN. A NaN grace makes `cutoff` NaN,
    // and `mtimeMs >= NaN` is FALSE, so planBlobGc falls through and condemns
    // EVERY unreferenced blob regardless of age. A zero/NaN interval makes
    // setInterval fire about every millisecond.
    for (const bad of ['abc', 'NaN', '-1', 'Infinity']) {
      expect(
        () => resolveBlobGcConfig({ COLLAB_BLOB_GC_GRACE_MS: bad }),
        `grace ${JSON.stringify(bad)} was accepted`,
      ).toThrow(/COLLAB_BLOB_GC_GRACE_MS/);
    }
    // 2^31 is ABOVE setInterval's ceiling, where Node clamps to 1ms - the same
    // flood as 0, reached from the other end.
    for (const bad of ['abc', '0', '-5', 'NaN', '2147483648', '1e30']) {
      expect(
        () => resolveBlobGcConfig({ COLLAB_BLOB_GC_INTERVAL_MS: bad }),
        `interval ${JSON.stringify(bad)} was accepted`,
      ).toThrow(/COLLAB_BLOB_GC_INTERVAL_MS/);
    }
    // A grace of 0 is legitimate (sweep aggressively); an interval of 0 is not.
    expect(resolveBlobGcConfig({ COLLAB_BLOB_GC_GRACE_MS: '0' }).graceMs).toBe(0);
    // Empty/unset falls back rather than becoming 0.
    expect(resolveBlobGcConfig({ COLLAB_BLOB_GC_GRACE_MS: '' }).graceMs).toBeGreaterThan(0);
  });

  it('publishes sweep counters on the metrics registry', async () => {
    const dataDir = tmp();
    fs.mkdirSync(path.join(dataDir, 'blobs'), { recursive: true });
    const sweepCount = () =>
      Number(
        /^collab_blob_gc_sweeps_total(?:\{[^}]*\})? (\d+(?:\.\d+)?)$/m.exec(
          defaultMetrics.render(),
        )?.[1] ?? 0,
      );
    const before = sweepCount();

    const worker = startBlobGc({
      dataDir,
      storage: new FsBlobStorage(dataDir),
      config: { enabled: true, intervalMs: 60_000, graceMs: 1000 },
    });
    expect(worker).not.toBeNull();
    await worker!.runOnce();
    worker!.stop();
    // Asserting only that the NAME appears is not enough: startBlobGc registers
    // the counter before runOnce executes, so a name check passes even if a
    // successful sweep never increments it. Measure the delta instead.
    expect(sweepCount()).toBeGreaterThan(before);
  });
});
