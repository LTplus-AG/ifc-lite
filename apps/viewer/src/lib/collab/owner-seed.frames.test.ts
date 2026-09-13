/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4444 — the owner's seed must reach the relay as a handful of update frames,
 * not one per entity.
 *
 * `seedGeometryToRoom` resolves every mesh's entity path through a callback
 * that, in the viewer, stamps that entity's placement baseline into the doc.
 * Unbatched, each stamp was its own Yjs transaction, i.e. one websocket frame:
 * two copies of AC20-FZK-Haus.ifc produced ~245 frames in one burst, the
 * relay's per-connection write budget (200 + 60/s by default) dropped the
 * tail, and Yjs held every later frame from the owner pending behind the gap
 * — a guest got the second copy without geometry and without a notice. This
 * pins the frame count of a two-copy seed to its transaction structure, on a
 * synthetic model large enough to have tripped the budget, so no fixture is
 * needed to guard it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as collab from '@ifc-lite/collab';
import type { ModelSlotRef } from '@ifc-lite/collab';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
import type { CollabSeedModel } from './owner-seed.js';
import { roomSlotRef } from './model-slot-ref.js';
import { ownerShare } from '../../test/collab-room-harness.js';

/** More entities with a mesh than the relay's default burst budget (200), per copy. */
const ELEMENTS = 260;
const STOREY_ID = 1;

function guidOf(id: number): string {
  return `0aBcDeFgHiJkLmNoP${id.toString(36).padStart(5, '0')}`;
}

/** A STEP-shaped store: one storey containing `ELEMENTS` walls, the same in every copy. */
function stepStore(): IfcDataStore {
  const rows = new Map<number, { guid: string; name: string; type: string; step: string }>();
  rows.set(STOREY_ID, { guid: guidOf(STOREY_ID), name: 'Level 1', type: 'IfcBuildingStorey', step: 'IFCBUILDINGSTOREY' });
  for (let id = 2; id < 2 + ELEMENTS; id++) {
    rows.set(id, { guid: guidOf(id), name: `Wall-${id}`, type: 'IfcWall', step: 'IFCWALL' });
  }
  return {
    source: new Uint8Array(0),
    entityIndex: {
      byId: new Map(Array.from(rows, ([id, r]) => [id, { type: r.step, byteOffset: 0, byteLength: 0 }])),
      byType: new Map(),
    },
    entities: {
      getGlobalId: (id: number) => rows.get(id)?.guid ?? '',
      getName: (id: number) => rows.get(id)?.name ?? '',
      getDescription: () => '',
      getObjectType: () => '',
      getTypeName: (id: number) => rows.get(id)?.type ?? 'Unknown',
    },
    properties: { getForEntity: () => [] },
    relationships: { getRelated: () => [] },
    spatialHierarchy: {
      project: { expressId: STOREY_ID, children: [], elements: Array.from({ length: ELEMENTS }, (_, i) => i + 2) },
      storeyElevations: new Map(),
    },
    schemaVersion: 'IFC4',
  } as unknown as IfcDataStore;
}

/** One triangle per wall, distinct per copy (`x`), carrying the copy's global ids. */
function meshes(x: number, idOffset: number): MeshData[] {
  return Array.from({ length: ELEMENTS }, (_, i) => ({
    expressId: i + 2 + idOffset,
    ifcType: 'IfcWall',
    positions: new Float32Array([x + i, 0, 0, x + i + 1, 0, 0, x + i, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  }));
}

describe('owner seed frame budget (#4444)', () => {
  it('two copies of a 260-element model seed in a handful of doc updates, not one per entity', async () => {
    const doc = collab.createCollabDoc();
    const blobStore = new collab.MemoryBlobStore();
    const B_OFFSET = 1_000_000;
    const models: CollabSeedModel[] = [
      { modelId: 'A', name: 'big.ifc', store: stepStore(), isIfcx: false, meshes: meshes(0, 0), idOffset: 0, schemaVersion: 'IFC4', fileName: 'big.ifc' },
      { modelId: 'B', name: 'big.ifc', store: stepStore(), isIfcx: false, meshes: meshes(500, B_OFFSET), idOffset: B_OFFSET, schemaVersion: 'IFC4', fileName: 'big.ifc' },
    ];
    const roomModels = new Map<string, ModelSlotRef>([
      ['A', roomSlotRef(0)],
      ['B', roomSlotRef(1)],
    ]);
    // Every 'update' event is what a websocket provider sends as one frame.
    let frames = 0;
    doc.on('update', () => {
      frames += 1;
    });
    const { outcome } = await ownerShare(doc, blobStore, models, roomModels);
    assert.deepEqual(outcome, { phase: 'ready', failure: null });
    // What landed: every element of both copies, with its baseline stamped.
    assert.equal(doc.getMap('entities').size, 2 * (ELEMENTS + 1));
    for (const slot of ['m0', 'm1']) {
      for (let id = 2; id < 2 + ELEMENTS; id++) {
        const path = `/${slot}/${guidOf(id)}`;
        assert.equal(collab.getGeometryRef(doc, path)?.geomIds.length, 1, `${path} has its mesh`);
        assert.ok(collab.getPlacementBaseline(doc, path), `${path} has its baseline`);
      }
    }
    // Per slot: the slot record, the structure seed, the mesh resolve (every
    // baseline stamp in ONE transaction) and the geometry records + refs; then
    // the seed marker. Anything per entity here is the regression.
    const perSlot = 4;
    assert.equal(frames, 2 * perSlot + 1, `frames sent for the two-copy seed`);
  });
});
