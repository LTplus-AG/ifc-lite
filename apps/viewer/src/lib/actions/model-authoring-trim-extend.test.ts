/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { readWallJoinTarget, trimExtendElementInStore } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { resolveLinearElementChain } from '@/lib/linear-element-edit';
import { GROUND_STOREY, SAMPLE_MODEL, danglingReferences, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
import { commitModelAuthoring } from './model-authoring-commit';
import { previewModelAuthoring } from './model-authoring-preview';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const s = useViewerStore.getState;
function created(result: { expressId: number } | { error: string }): number {
  assert.ok('expressId' in result, 'error' in result ? result.error : '');
  return result.expressId;
}
const line = (x: number, y: number) => ({ a: [x, y - 5] as [number, number], b: [x, y + 5] as [number, number], tMin: 0, tMax: 1, reach: 0 });
function proposal(operation: unknown) {
  return parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native reach', units: 'm', frame: 'storey-local', operations: [operation] }));
}
async function exported() {
  const state = s(), store = state.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  const bytes = editedModelBytes(store, state.mutationViews.get(SAMPLE_MODEL)!);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
  const parsed = await parseIfc(bytes), view = new MutablePropertyView(parsed.properties, SAMPLE_MODEL);
  return { store: parsed, view, editor: new StoreEditor(parsed, view), scale: getModelLengthUnitScale(parsed) };
}

test('#7262 reviewed Trim/Extend admits native wall trim independently proven by IFC export', async () => {
  const { dataStore } = await seedAuthoringSample();
  const wall = created(s().addWall(SAMPLE_MODEL, dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),
    { Start: [0, 5, 0], End: [8, 5, 0], Thickness: .2, Height: 3, Name: 'Native reach wall' }));
  const gid = s().mutationViews.get(SAMPLE_MODEL)!.getNewEntity(wall)!.attributes[0];
  assert.ok(typeof gid === 'string');
  const result = recordModellingEdit(useViewerStore, SAMPLE_MODEL, (_methods, editor) =>
    trimExtendElementInStore(dataStore, editor, wall, { mode: 'trim', click: [8, 5], boundary: line(6, 5) }));
  assert.equal(result.length, 6);
  const read = await exported(), id = read.store.entities.getExpressIdByGlobalId(gid);
  assert.ok(id > 0, 'Native trim preserves the exported root GlobalId');
  const current = readWallJoinTarget(read.store, read.view, id, read.scale);
  assert.ok(current);
  assert.deepEqual(current.wall.start, [0, 5]);
  assert.deepEqual(current.wall.end, [6, 5]);
  assert.doesNotThrow(() => proposal({ op: 'element.trimExtend', mode: 'extend',
    target: { globalId: gid, ifcClass: 'IfcWall', name: 'Native reach wall' },
    expected: { kind: 'wall', wall: current }, click: [6, 5], boundary: { line: line(10, 5) } }),
  'Assistant review must admit the native wall operation already proven by independent reparse');
  const preview=previewModelAuthoring(s(),proposal({op:'element.trimExtend',mode:'extend',target:{globalId:gid,ifcClass:'IfcWall',name:'Native reach wall'},expected:{kind:'wall',wall:current},click:[6,5],boundary:{line:line(10,5)}}));
  assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);
  const committed=commitModelAuthoring(useViewerStore,preview,new Set([0]),'native reach witness');assert.ok(committed.ok,committed.ok?'':committed.detail??committed.reason);
  const changed=await exported();assert.deepEqual(readWallJoinTarget(changed.store,changed.view,changed.store.entities.getExpressIdByGlobalId(gid),changed.scale)?.wall.end,[10,5]);

});

test('#7262 reviewed Trim/Extend admits a native sloped beam extension with its exported axis intact', async () => {
  const { dataStore } = await seedAuthoringSample();
  const beam = created(s().addBeam(SAMPLE_MODEL, dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY),
    { Start: [0, 20, 0], End: [8, 20, 2], Width: .2, Height: .3, Name: 'Native sloped reach' }));
  const gid = s().mutationViews.get(SAMPLE_MODEL)!.getNewEntity(beam)!.attributes[0];
  assert.ok(typeof gid === 'string');
  const result = recordModellingEdit(useViewerStore, SAMPLE_MODEL, (_methods, editor) =>
    trimExtendElementInStore(dataStore, editor, beam, { mode: 'extend', click: [8, 20], boundary: line(10, 20) }));
  assert.ok(Math.abs(result.length - Math.hypot(10, 2.5)) < 1e-9);
  const read = await exported(), id = read.store.entities.getExpressIdByGlobalId(gid);
  const chain = resolveLinearElementChain(read.store, read.view, read.editor, id, read.scale);
  assert.ok(chain);
  assert.ok(Math.abs(chain.depth - Math.hypot(10, 2.5)) < 1e-9);
  assert.ok(Math.abs(chain.axisDirection[2] - 2 / Math.hypot(8, 2)) < 1e-9);
  assert.doesNotThrow(() => proposal({ op: 'element.trimExtend', mode: 'trim',
    target: { globalId: gid, ifcClass: 'IfcBeam', name: 'Native sloped reach' },
    expected: { kind: 'beam', chain }, click: [10, 20], boundary: { line: line(6, 20) } }),
  'Assistant review must admit the native sloped beam operation without changing its axis');
  const preview=previewModelAuthoring(s(),proposal({op:'element.trimExtend',mode:'trim',target:{globalId:gid,ifcClass:'IfcBeam',name:'Native sloped reach'},expected:{kind:'beam',chain},click:[10,20],boundary:{line:line(6,20)}}));
  assert.equal(preview.rows[0].status,'ready',preview.rows[0].issue);
  assert.ok(commitModelAuthoring(useViewerStore,preview,new Set([0]),'native sloped witness').ok);
  const changed=await exported(),actual=resolveLinearElementChain(changed.store,changed.view,changed.editor,changed.store.entities.getExpressIdByGlobalId(gid),changed.scale);assert.ok(actual);
  assert.ok(Math.abs(actual.depth-Math.hypot(6,1.5))<1e-9,'reviewed native trim persists the correct sloped depth');

});

test('#7262 existing native creation preview remains a green unpublished control', async () => {
  await seedAuthoringSample();
  const before = s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount();
  const batch = proposal({ op: 'element.create', ref: 'control', ifcClass: 'IfcWall', name: 'Existing control',
    storey: { globalId: GROUND_STOREY }, params: { start: [0, 30, 0], end: [8, 30, 0], height: 3, thickness: .2 } });
  const preview = previewModelAuthoring(s(), batch);
  assert.deepEqual(preview.rows.map(row => [row.status, row.issue]), [['ready', undefined]]);
  assert.equal(s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount(), before);
});
