/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { IfcAPI } from '@ifc-lite/wasm';
import { alignElementsInStore, planBoxOf, readWallJoinTarget, transformElementsInStore } from '@ifc-lite/create';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { meshWalls } from '../../../../../packages/create/src/in-store/wall-join-mesh.oracle';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original, true));
const batch = (operations: unknown[]) => parseModelAuthoringBatch(JSON.stringify({
  version: 1, kind: 'model.authoring', title: 'Native placement audit', units: 'm', frame: 'storey-local', operations,
}));
async function setup() {
  const { dataStore, view } = await seedAuthoringSample();
  const make = (start: [number, number, number], end: [number, number, number]) => {
    const made = useViewerStore.getState().addWall(SAMPLE_MODEL, dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),
      { Start: start, End: end, Thickness: .2, Height: 3, Name: 'Placement audit wall' });
    assert.ok('expressId' in made, 'error' in made ? made.error : '');
    return made.expressId;
  };
  const id = make([10, 10, 0], [15, 10, 0]);
  const target = modelEditTarget(useViewerStore.getState(), SAMPLE_MODEL); assert.ok(target);
  return { dataStore, view, id, target, make };
}
async function startOf(s: Awaited<ReturnType<typeof setup>>, id = s.id) {
  const parsed = await parseIfc(editedModelBytes(s.dataStore, s.view));
  const read = readWallJoinTarget(parsed, new MutablePropertyView(parsed.properties, SAMPLE_MODEL), id, .001);
  assert.ok(read);
  return read.wall.start.map(v => Math.round(v * 1e6) / 1e6);
}

// Campaign #6812 P15A audit: native writers are controls, not fabricated preview returns.
test('native explicit-pivot writer persists the off-origin rotation in independent STEP reparse', async () => {
  const s = await setup();
  s.target.editor.runAtomic(editor => transformElementsInStore({ dataStore: s.dataStore,
    view: editor.getMutationView(), editor, selected: [s.id], op: { kind: 'rotate', pivot: [0, 0], angle: Math.PI / 2 } }));
  assert.deepEqual(await startOf(s), [-10, 10]);
});

test('reviewed explicit-pivot request must preserve the native pivot rather than rotate about the origin', async () => {
  const s = await setup();
  const guid = s.view.getNewEntity(s.id)?.attributes[0]; assert.equal(typeof guid, 'string');
  const preview = previewModelAuthoring(useViewerStore.getState(), batch([
    { op: 'element.rotate', target: { globalId: guid, modelId: SAMPLE_MODEL, ifcClass: 'IfcWall', name: 'Placement audit wall' }, angleDeg: 90, pivot: [0, 0] },
  ]));
  assert.equal(preview.rows[0].status, 'ready');
  const applied = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'native audit');
  assert.ok(applied.ok, applied.ok ? '' : applied.detail ?? applied.reason);
  assert.deepEqual(await startOf(s), [-10, 10], 'An explicit native pivot cannot be silently discarded');
});

test('native Align uses real exported mesh bounds and moves the target while retaining reference ownership', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(), other = s.make([20, 20, 0], [25, 20, 0]), api = new IfcAPI();
  const meshes = meshWalls(api, new TextDecoder().decode(editedModelBytes(s.dataStore, s.view)));
  const boxes = new Map([s.id, other].map(id => {
    const vertices = meshes.get(id); assert.ok(vertices?.length);
    // Canonical bounds consumer over the real WASM positions; normals/colors are not read by it.
    const box = planBoxOf(vertices.map((mesh): MeshData => ({ expressId: id, positions: Float32Array.from(mesh.positions),
      indices: mesh.indices, normals: new Float32Array(0), color: [1, 1, 1, 1] })), id,
    { renderToLocal: ([x, y, z]) => [x, -z, y] });
    assert.ok(box); return [id, box] as const;
  }));
  s.target.editor.runAtomic(editor => alignElementsInStore({ dataStore: s.dataStore, view: editor.getMutationView(), editor },
    { reference: s.id, targets: [other], mode: 'left' }, boxes));
  assert.deepEqual(await startOf(s), [10, 10]);
  assert.deepEqual(await startOf(s, other), [10, 20]);
});

test('reviewed native Align must have a supported proposal contract', async () => {
  const s = await setup(), other = s.make([20, 20, 0], [25, 20, 0]);
  const ref = (id: number) => ({ modelId: SAMPLE_MODEL, globalId: s.view.getNewEntity(id)?.attributes[0], ifcClass: 'IfcWall', name: 'Placement audit wall' });
  assert.doesNotThrow(() => batch([{ op: 'element.align', reference: ref(s.id), targets: [ref(other)], mode: 'left' }]),
    'The existing native Align operation is currently absent from reviewed authoring');
});
