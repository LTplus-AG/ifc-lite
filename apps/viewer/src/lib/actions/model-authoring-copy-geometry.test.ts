/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { IfcQuery } from '@ifc-lite/query';
import { IfcAPI } from '@ifc-lite/wasm';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
import { useViewerStore } from '@/store';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { seedZoneExport } from '@/test/zone-export-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { parseIfc } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { authoringGhosts } from './model-authoring-ghost';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const bounds = (meshes: readonly MeshData[]) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshes) for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    const value = mesh.positions[i + k] + (mesh.origin?.[k] ?? 0);
    min[k] = Math.min(min[k], value); max[k] = Math.max(max[k], value);
  }
  return { min, max };
};

function geometry(bytes: Uint8Array): MeshData[] {
  const api = new IfcAPI();
  const out: MeshData[] = [];
  try {
    api.setComputeGeometryHashes(0.001);
    const pre = api.buildPrePassOnce(bytes);
    const meshes = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try {
      const volumes = new Map(Array.from(meshes.geometryHashIds, (id, index) => [id, meshes.geometryVolumeValues[index]]));
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes.get(i); assert.ok(mesh);
        try {
          const color = mesh.color, origin = mesh.origin;
          out.push({ expressId: mesh.expressId, positions: mesh.positions, normals: mesh.normals, indices: mesh.indices,
            color: [color[0], color[1], color[2], color[3]], origin: [origin[0], origin[1], origin[2]], geometryVolume: volumes.get(mesh.expressId) });
        } finally { mesh.free(); }
      }
    } finally { meshes.free(); }
  } finally { api.clearPrePassCache(); api.free(); }
  return out;
}

// #7202: the source mesh and the exported copy both pass through the real canonical WASM batch.
test('#7202 a native Bonsai copy ghost agrees with the exported copy geometry and remains on its own overlay channel', async (t) => {
  if (!ensureWasm(t)) return;
  const { store, wall, walls } = await seedZoneExport();
  const view = new MutablePropertyView(store.properties || null, 'bonsai');
  configureMutationView(view, store);
  useViewerStore.setState({ editEnabled: true, collabRole: null, collabRoomId: null, mutationVersion: 0,
    mutationViews: new Map([['bonsai', view]]), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(),
    mutationBatchTags: new Map(), removedNewEntities: new Map(), removedMeshes: new Map(), pendingMeshRemovals: null, dirtyModels: new Set() });
  const target = { globalId: store.entities.getGlobalId(wall.expressId), modelId: 'bonsai', ifcClass: 'IfcWall', name: store.entities.getName(wall.expressId) ?? '' };
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Bonsai copy', units: 'mm', frame: 'storey-local',
    operations: [{ op: 'element.copy', target, ref: 'wall-copy', offset: [1000, 0, 0] }] }));
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.deepEqual(preview.rows.map(row => [row.status, row.issue]), [['ready', undefined]]);
  const ghosts = authoringGhosts(useViewerStore.getState(), preview);
  assert.ok(ghosts.length > 0, 'real source meshes produce a copy ghost');
  assert.equal(view.getNewEntities().length, 0);
  const source = bounds(walls.filter(mesh => mesh.expressId === wall.expressId));
  const ghost = bounds(ghosts);
  assert.ok(Math.abs(ghost.min[0] - source.min[0] - 1) < 0.001, 'declared millimetres become exactly one metre on the source storey');
  const restore = setRequestRemesh(() => {});
  let outcome;
  try { outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test'); } finally { restore(); }
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const bytes = editedModelBytes(store, view);
  const parsed = await parseIfc(bytes);
  const id = parsed.entities.getExpressIdByGlobalId(outcome.receipt.applied[0].globalId);
  assert.ok(id > 0);
  const originalOpenings = new IfcQuery(store).entity(wall.expressId).voids();
  const copiedOpenings = new IfcQuery(parsed).entity(id).voids();
  assert.ok(originalOpenings.length > 0, 'committed Bonsai host contains actual openings');
  assert.equal(copiedOpenings.length, originalOpenings.length, 'native host copies retain every actual source opening');
  const originalIds = new Set(originalOpenings.map(opening => opening.globalId));
  assert.ok(copiedOpenings.every(opening => !originalIds.has(opening.globalId)), 'copied dependents have fresh identities');
  const copiedMeshes = geometry(bytes).filter(mesh => mesh.expressId === id);
  assert.ok(copiedMeshes.length > 0, 'exported copy produces actual WASM geometry');
  assert.ok(Math.abs((copiedMeshes[0].geometryVolume ?? 0) - (wall.geometryVolume ?? 0)) < 0.001, 'real copied geometry retains the original cut volume, not only its bounding box');
  const copied = bounds(copiedMeshes);
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(ghost.min[k] - copied.min[k]) < 0.001 && Math.abs(ghost.max[k] - copied.max[k]) < 0.001, `native copy ghost and exported geometry agree on axis ${k}`);
  }
  assert.ok(ghosts.every(mesh => mesh.expressId !== wall.expressId));
  assert.ok(useViewerStore.getState().geometryResult?.meshes.some(mesh => mesh.expressId === wall.expressId), 'original published source meshes remain');
});

test('#7202 control: committed Bonsai source independently retains its known cut volume and two openings', async (t) => {
  if (!ensureWasm(t)) return;
  const { store, wall } = await seedZoneExport();
  assert.equal(store.entities.getGlobalId(wall.expressId), '2JUHrTM_j3UxZiBnyBfByx');
  assert.equal(new IfcQuery(store).entity(wall.expressId).voids().length, 2);
  assert.ok(Math.abs((wall.geometryVolume ?? 0) - 2.784) < 0.001);
});
