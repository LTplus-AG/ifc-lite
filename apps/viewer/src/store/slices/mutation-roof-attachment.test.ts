/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { addRoofToStore } from '../../../../../packages/create/src/in-store/roof.js';
import { addWallToStore } from '../../../../../packages/create/src/in-store/wall.js';
import { setTopConstraintInStore } from '../../../../../packages/create/src/in-store/storey/storey-top-constraint.js';
import { addSlabToStore } from '../../../../../packages/create/src/in-store/slab.js';
import { writeTopAttachment } from '../../../../../packages/create/src/in-store/storey/storey-attachment.js';
import { toGlobalIdFromModels } from '@/store/globalId';
import { newStorey, exportText, meshWalls, insideMesh } from '../../../../../packages/create/src/in-store/wall-join-mesh.oracle.js';
const wasm = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
for (const movement of ['translate', 'position'] as const) it(`public roof ${movement} refits the actual attached wall and undoes both in one step (#9296)`, { skip: !existsSync(wasm) && 'Build WASM to check native wall geometry' }, async () => {
  initSync({ module: readFileSync(wasm) });
  const api = new IfcAPI();
  try {
    const s = await newStorey();
    const roof = addRoofToStore(s.editor, s.anchor, { Position: [0,0,4], Width: 10, Depth: 8, Thickness: .25, EdgeSlopes: [Math.PI / 6,0,Math.PI / 6,0], Overhang: .5 }).roofId;
    const wall = addWallToStore(s.editor, s.anchor, { Start: [5,0,0], End: [5,8,0], Height: 3, Thickness: .2 }).wallId;
    setTopConstraintInStore(s.store, s.editor, wall, { kind: 'roof', roofId: roof });
    useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: s.store }),
      editEnabled: true, collabRoomId: null, collabSession: null,
      mutationViews: new Map([['m', s.view]]), storeEditors: new Map([['m', s.editor]]),
      undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), removedNewEntities: new Map(),
      dirtyModels: new Set(), mutationVersion: 0, canCollabEdit: () => true,
    });
    const inside = (z: number) => insideMesh(meshWalls(api, exportText(s)).get(wall) ?? [], [5,z,-4]);
    assert.equal(inside(7.28), false);
    const state = useViewerStore.getState();
    const result = movement === 'translate' ? state.translateEntity('m', roof, [0,0,1]) : state.setEntityPosition('m', roof, [0,0,5]);
    assert.ok(result.ok, result.ok ? '' : result.reason);
    assert.equal(inside(7.28), true, 'the native wall reaches the lifted roof, through the public viewer action');
    state.undo('m');
    assert.equal(inside(6.28), true);
    assert.equal(inside(7.28), false, 'one Undo restores the wall and roof together');
  } finally { api.free(); }
});

type Storey = Awaited<ReturnType<typeof newStorey>>;
function seedViewer(s: Storey, mirrored: unknown[]): void {
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: s.store }),
    editEnabled: true, collabRoomId: null, collabSession: null,
    mutationViews: new Map([['m', s.view]]), storeEditors: new Map([['m', s.editor]]),
    undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), removedNewEntities: new Map(),
    mutationMeshTranslations: new Map(), pendingMeshTranslations: null,
    dirtyModels: new Set(), mutationVersion: 0, canCollabEdit: () => true,
    mirrorPlacementEdit: (modelId, id, delta) => { mirrored.push([modelId, id, delta]); },
  });
}

for (const movement of ['translate', 'position'] as const) it(`public slab ${movement} with an attached wall mirrors the slab placement to the room (#9296)`, async () => {
  const s = await newStorey(), mirrored: unknown[] = [];
  const slab = addSlabToStore(s.editor, s.anchor, { Position: [0, 0, 4], Width: 10, Depth: 8, Thickness: .3, ExtrudedDirection: [0, 0, -1] }).slabId;
  const wall = addWallToStore(s.editor, s.anchor, { Start: [1, 2, 0], End: [9, 2, 0], Height: 3, Thickness: .2 }).wallId;
  setTopConstraintInStore(s.store, s.editor, wall, { kind: 'slab', slabId: slab });
  seedViewer(s, mirrored);
  const state = useViewerStore.getState();
  const result = movement === 'translate' ? state.translateEntity('m', slab, [0, 0, 1]) : state.setEntityPosition('m', slab, [0, 0, 5]);
  assert.ok(result.ok, result.ok ? '' : result.reason);
  assert.deepEqual(mirrored, [['m', slab, [0, 0, 1]]], 'peers receive the slab placement, as for any other move');
});

it('a storey-attached wall keeps the plain move presentation and placement mirror (#9296)', async () => {
  const s = await newStorey(), mirrored: unknown[] = [];
  const wall = addWallToStore(s.editor, s.anchor, { Start: [1, 2, 0], End: [9, 2, 0], Height: 3, Thickness: .2 }).wallId;
  writeTopAttachment(s.view, wall, 'NextStoreyAbove', 'relative');
  seedViewer(s, mirrored);
  const result = useViewerStore.getState().translateEntity('m', wall, [1, 0, 0]);
  assert.ok(result.ok, result.ok ? '' : result.reason);
  const state = useViewerStore.getState();
  assert.deepEqual(state.pendingMeshTranslations?.get(toGlobalIdFromModels(state.models, 'm', wall)), [1, 0, -0]);
  assert.deepEqual(mirrored, [['m', wall, [1, 0, 0]]]);
});
