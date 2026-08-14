/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The thread seam of the zone geometry export (#2508 item 2).
 *
 * `useZoneGeometrySplit.test.ts` covers the routing: which element's geometry
 * lands in which file. This covers what moving the cut into a worker added, and
 * every assertion here is about something that would still produce a CORRECT
 * file if it broke - which is exactly why it needs a test rather than a look:
 *
 *  - only the elements that need CUTTING cross the boundary (an export that
 *    shipped the whole elements too would be right, and would copy megabytes of
 *    geometry per run for nothing);
 *  - progress is reported per element (the panel's counter is the only sign a
 *    long run is alive);
 *  - a worker that fails falls back to cutting in-process rather than losing
 *    the export.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store/index.js';
import { exportZoneGeometry } from './useZoneGeometrySplit.js';
import { runZoneSplitBatch } from '@/workers/zoneSplit.worker.js';
import type { ZoneSplitBatchFn, ZoneSplitJob } from '@/lib/zones/split-worker-client.js';
import type { SplitMeshByZonesFn } from '@/lib/zones/split.js';
import type { ZoneSet } from '@/lib/zones';

const STRADDLER_A = 10;
const STRADDLER_B = 11;
/** Sits wholly inside zone B, so it is copied rather than cut. */
const WHOLE = 12;

const ZONE_SET: ZoneSet = {
  id: 'set-1',
  name: 'Takt areas',
  zones: [
    { id: 'z-a', name: 'Takt A', center: [0, 0, 0], size: [10, 10, 10], rotationY: 0 },
    { id: 'z-b', name: 'Takt B', center: [10, 0, 0], size: [10, 10, 10], rotationY: 0 },
  ],
  visible: true,
  createdAt: 0,
  updatedAt: 0,
};

function mesh(expressId: number, x = 0): MeshData {
  return {
    expressId,
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 0, 0, 1],
  } as MeshData;
}

/** A split that puts 1 m3 in each zone. */
const split: SplitMeshByZonesFn = () => ({
  pieceCount: 2,
  wholeVolume: 2,
  sumErrorRel: 0,
  remainderFailed: false,
  piece(index: number) {
    return {
      zoneIndex: index,
      positions: new Float64Array([index, 0, 0, index + 1, 0, 0, index, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      volume: 1,
      free() {},
    };
  },
  free() {},
});

function seed() {
  useViewerStore.setState({
    zoneSets: [ZONE_SET],
    zoneAssignments: new Map([
      [STRADDLER_A, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: true, touchedZoneIds: ['z-a', 'z-b'] } }],
      [STRADDLER_B, { 'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: true, touchedZoneIds: ['z-a', 'z-b'] } }],
      [WHOLE, { 'set-1': { zoneId: 'z-b', zoneName: 'Takt B', straddles: false, touchedZoneIds: ['z-b'] } }],
    ]) as never,
    geometryResult: {
      meshes: [
        { expressId: STRADDLER_A, geometryVolume: 2 },
        { expressId: STRADDLER_B, geometryVolume: 2 },
        { expressId: WHOLE, geometryVolume: 5 },
      ],
    } as never,
    models: new Map(),
  } as never);
}

/** Run an export with a batch that records what it was asked to do. */
async function runWithSpy(zoneIndex: number, batchImpl?: ZoneSplitBatchFn) {
  const seen: ZoneSplitJob[][] = [];
  const progress: Array<[number, number]> = [];
  const result = await exportZoneGeometry(ZONE_SET, zoneIndex, {
    split,
    meshPieces: (globalId) => [mesh(globalId, globalId === WHOLE ? 9 : 0)],
    emit: () => {},
    onProgress: (done, total) => progress.push([done, total]),
    batch: batchImpl ?? (async (request, onProgress) => {
      seen.push(request.jobs);
      return runZoneSplitBatch(split, { ...request, zones: [...request.zones] }, onProgress);
    }),
  });
  return { result, seen, progress };
}

describe('zone geometry export: what crosses the thread boundary', () => {
  beforeEach(seed);

  it('sends the elements that need CUTTING, and only those', async () => {
    const { result, seen } = await runWithSpy(1);
    assert.ok(result.ok);
    assert.equal(seen.length, 1, 'the batch should be one round trip, not one per element');
    assert.deepEqual(seen[0].map((job) => job.globalId).sort(), [STRADDLER_A, STRADDLER_B]);
    // The whole element still reached the file, without being sent anywhere.
    assert.equal(result.ok && result.summary.whole, 1);
    assert.equal(result.ok && result.summary.cut, 2);
  });

  it('sends the geometry itself, since the worker has no scene to read it from', async () => {
    const { seen } = await runWithSpy(1);
    const job = seen[0][0];
    assert.equal(job.pieces.length, 1);
    assert.equal(job.pieces[0].positions.length, 9);
    assert.equal(job.pieces[0].indices.length, 3);
  });

  it('reports progress per element, so a long run can show where it is', async () => {
    const { progress } = await runWithSpy(1);
    assert.deepEqual(progress, [[1, 2], [2, 2]]);
  });

  it('runs no batch at all when nothing needs cutting', async () => {
    // Only the wholly-inside element is in this zone, and it is copied. A round
    // trip here would be a worker spawned, a wasm module compiled, and a file
    // produced no differently.
    useViewerStore.setState({
      zoneAssignments: new Map([
        [WHOLE, { 'set-1': { zoneId: 'z-b', zoneName: 'Takt B', straddles: false, touchedZoneIds: ['z-b'] } }],
      ]) as never,
    } as never);
    const { result, seen } = await runWithSpy(1);
    assert.ok(result.ok);
    assert.equal(seen.length, 0);
    assert.equal(result.ok && result.summary.whole, 1);
  });

  it('propagates a batch failure rather than emitting a partial file', async () => {
    // The default batch falls back to the main thread when the WORKER fails,
    // but a batch that rejects outright must not produce a file missing every
    // straddler: a per-section model that quietly lost its cut pieces looks
    // finished.
    const emitted: string[] = [];
    await assert.rejects(
      exportZoneGeometry(ZONE_SET, 1, {
        split,
        meshPieces: (globalId) => [mesh(globalId, globalId === WHOLE ? 9 : 0)],
        emit: (_bytes, filename) => emitted.push(filename),
        batch: async () => { throw new Error('worker gone'); },
      }),
      /worker gone/,
    );
    assert.deepEqual(emitted, []);
  });
});

describe('one export at a time', () => {
  beforeEach(seed);

  it('refuses a second run while the first is still cutting', async () => {
    // The lock has to outlive the PANEL, not just the click: now that the UI
    // stays live during a cut, the panel can be closed and reopened, which
    // resets anything the component owns. A second run would compile a second
    // wasm module and cut the same elements again for an identical download.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow = exportZoneGeometry(ZONE_SET, 1, {
      split,
      meshPieces: (globalId) => [mesh(globalId, globalId === WHOLE ? 9 : 0)],
      emit: () => {},
      batch: async (request, onProgress) => {
        await held;
        return runZoneSplitBatch(split, { ...request, zones: [...request.zones] }, onProgress);
      },
    });

    const second = await exportZoneGeometry(ZONE_SET, 1, {
      split,
      meshPieces: (globalId) => [mesh(globalId)],
      emit: () => { throw new Error('the second run produced a file'); },
    });
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, 'busy');

    release?.();
    assert.equal((await slow).ok, true);
  });

  it('releases the lock when a run throws, rather than wedging the button', async () => {
    await assert.rejects(exportZoneGeometry(ZONE_SET, 1, {
      split,
      meshPieces: (globalId) => [mesh(globalId, globalId === WHOLE ? 9 : 0)],
      emit: () => {},
      batch: async () => { throw new Error('worker gone'); },
    }));

    const after = await exportZoneGeometry(ZONE_SET, 1, {
      split,
      meshPieces: (globalId) => [mesh(globalId, globalId === WHOLE ? 9 : 0)],
      emit: () => {},
      batch: async (request, onProgress) =>
        runZoneSplitBatch(split, { ...request, zones: [...request.zones] }, onProgress),
    });
    assert.equal(after.ok, true, 'the lock was never released');
  });
});

describe('runZoneSplitBatch', () => {
  it('returns the piece for the zone asked for, not the first one', () => {
    const jobs: ZoneSplitJob[] = [{ globalId: STRADDLER_A, pieces: [mesh(STRADDLER_A)] }];
    const a = runZoneSplitBatch(split, { zones: ZONE_SET.zones, zoneIndex: 0, jobs });
    const b = runZoneSplitBatch(split, { zones: ZONE_SET.zones, zoneIndex: 1, jobs });
    assert.equal(a[0].piece?.zoneIndex, 0);
    assert.equal(b[0].piece?.zoneIndex, 1);
  });

  it('reports a refusal as ok:false, distinct from "this zone holds none of it"', () => {
    // A split whose pieces do not sum to the whole: `splitElementByZones`
    // refuses it, and the caller must be able to tell that apart from an
    // element that is simply not in this zone, because one is a warning to the
    // user and the other is normal.
    const disagreeing: SplitMeshByZonesFn = () => ({
      pieceCount: 0, wholeVolume: 2, sumErrorRel: 1, remainderFailed: false,
      piece: () => undefined, free() {},
    });
    const jobs: ZoneSplitJob[] = [{ globalId: STRADDLER_A, pieces: [mesh(STRADDLER_A)] }];
    const refused = runZoneSplitBatch(disagreeing, { zones: ZONE_SET.zones, zoneIndex: 0, jobs });
    assert.equal(refused[0].ok, false);

    const elsewhere = runZoneSplitBatch(split, { zones: ZONE_SET.zones, zoneIndex: 5, jobs });
    assert.equal(elsewhere[0].ok, true);
    assert.equal(elsewhere[0].piece, null);
  });
});
