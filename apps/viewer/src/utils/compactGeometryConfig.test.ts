/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { adoptCompactMeshes, COMPACT_CELL_METRES, type CompactPayload } from '@ifc-lite/geometry/compact';
import { activePerfFlags, recordAppliedPerfFlag } from '../lib/perf/flags-applied.js';
import { enableCompactGeometry } from './compactGeometryConfig.js';
import { compactCellSizeForLoad, compactGeometryRequested } from './compactGeometryFlag.js';

function setSearch(search: string): void {
  Object.defineProperty(globalThis, 'location', { value: { search }, configurable: true, writable: true });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'location');
  recordAppliedPerfFlag('compactGeom', undefined);
});

/** A PostHog flag source that answers only the compact ramp's key. */
const posthog = (value: unknown) => (key: string) => (key === 'perf-compact-geom' ? value : undefined);

describe('compact geometry flag', () => {
  it('is off with no flag set', () => {
    assert.equal(compactGeometryRequested('primary'), false);
    setSearch('?other=1');
    assert.equal(compactGeometryRequested('primary'), false);
  });

  it('is on for a primary load under ?compactGeom=1', () => {
    setSearch('?compactGeom=1');
    assert.equal(compactGeometryRequested('primary'), true);
  });

  it('keeps a federated load on f32 meshes: its ids are re-homed after the workers ran', () => {
    setSearch('?compactGeom=1');
    assert.equal(compactGeometryRequested('federated'), false);
  });

  it('follows the perf-compact-geom PostHog ramp when the URL does not set it', () => {
    assert.equal(compactGeometryRequested('primary', posthog(true)), true);
    assert.equal(compactGeometryRequested('primary', posthog(false)), false);
    assert.equal(compactGeometryRequested('primary', posthog(undefined)), false, 'flags not loaded yet: the default');
    assert.equal(compactGeometryRequested('federated', posthog(true)), false);
    setSearch('?compactGeom=0');
    assert.equal(compactGeometryRequested('primary', posthog(true)), false, 'an explicit URL off wins over the ramp');
  });

  it('reads an explicit off as off', () => {
    for (const value of ['0', 'false', '']) {
      setSearch(`?compactGeom=${value}`);
      assert.equal(compactGeometryRequested('primary'), false, `?compactGeom=${value}`);
    }
  });
});

/** Whether the record decoder has been fetched: without it a batch that carries payloads is refused. */
function decoderLoaded(): boolean {
  try {
    adoptCompactMeshes([], [{} as CompactPayload]);
    return true;
  } catch {
    return false;
  }
}

describe('the cell size for a load', () => {
  it('is undefined, and nothing is fetched, with the flag off or for a federated load', async () => {
    assert.equal(await compactCellSizeForLoad('primary'), undefined);
    setSearch('?compactGeom=1');
    assert.equal(await compactCellSizeForLoad('federated'), undefined);
    assert.equal(decoderLoaded(), false, 'neither call fetched the decoder');
  });

  it('reports what the primary load ran as its telemetry arm', async () => {
    assert.equal(await compactCellSizeForLoad('primary', { readFeatureFlag: posthog(false) }), undefined);
    assert.equal(activePerfFlags().compactGeom, undefined, 'the off arm is the default');
    assert.equal(await compactCellSizeForLoad('primary', { readFeatureFlag: posthog(true) }), COMPACT_CELL_METRES);
    assert.equal(activePerfFlags().compactGeom, 'true');
    assert.equal(await compactCellSizeForLoad('federated', { readFeatureFlag: posthog(false) }), undefined);
    assert.equal(activePerfFlags().compactGeom, 'true', 'a federated load does not change the primary load\'s arm');
    // A load superseded while it decided leaves the arm of the load that replaced it.
    assert.equal(await compactCellSizeForLoad('primary', { readFeatureFlag: posthog(false), isCurrent: () => false }), undefined);
    assert.equal(activePerfFlags().compactGeom, 'true');
  });

  it('is the default cell once the decoder and the page code are loaded', async () => {
    setSearch('?compactGeom=1');
    assert.equal(await compactCellSizeForLoad('primary'), COMPACT_CELL_METRES);
    assert.equal(decoderLoaded(), true);
    assert.equal(await enableCompactGeometry(), COMPACT_CELL_METRES);
    assert.equal(COMPACT_CELL_METRES, 32, 'the largest cell the encoder accepts');
  });
});

it('a compact mesh is backed as the f32 mesh it decodes to (geometry-backing record)', async () => {
  const { loadCompactGeometry } = await import('@ifc-lite/geometry/compact');
  const { decodeMeshRecord, encodeMeshRecord, SourcePool, TextureBitmapTable } = await import('../lib/geometry-backing/mesh-record.js');
  await loadCompactGeometry();
  // One triangle on the 2^-10 lattice: (0,0,0), (1,0,0), (0,1,0), normals +z.
  const payload: CompactPayload = {
    records: new Uint8Array(3 * 12), indices: Uint16Array.from([0, 1, 2]), table: Uint32Array.from([0, 0, 3, 0, 3, 10, 3]),
    windows: new Float64Array(3), bounds: Float64Array.from([0, 0, 0, 1, 1, 0]), cells: new Int32Array(3),
  };
  const view = new DataView(payload.records.buffer);
  [[0, 0], [1024, 0], [0, 1024]].forEach(([x, y], corner) => {
    view.setUint16(corner * 12, x, true);
    view.setUint16(corner * 12 + 2, y, true);
    view.setUint16(corner * 12 + 6, (128 << 8) | 128, true);
  });
  const mesh = { expressId: 7, color: [1, 1, 1, 1], positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), compact: { batch: 0, row: 0 } } as unknown as Parameters<typeof encodeMeshRecord>[0];
  adoptCompactMeshes([mesh], [payload]);
  assert.ok(mesh.compact);
  const encoded = encodeMeshRecord(mesh, new SourcePool(), new TextureBitmapTable());
  const restored = decodeMeshRecord(structuredClone(encoded.record), { source: () => { throw new Error('no pooled source'); }, bitmap: () => undefined });
  assert.equal(restored.compact, undefined, 'the record is an ordinary mesh');
  assert.deepEqual([...restored.positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual([...restored.indices], [0, 1, 2]);
});
