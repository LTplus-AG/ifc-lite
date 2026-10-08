/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { readWallJoinTarget, trimExtendElementInStore } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { seedModelingSession, MODEL_ID, STOREY } from '@/test/modeling-session-fixture';
import { seedAuthoringSample, parseIfc, GROUND_STOREY, SAMPLE_MODEL } from '@/test/authoring-sample-fixture';
import { configureMutationView } from '@/utils/configureMutationView';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { resolvePlacementChain } from '@/lib/placement-edit';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { nativeReachPin } from './model-authoring-reach-fields';
import { nativeAuthoringReach, writeAuthoringReach } from './model-authoring-reach';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

type Parent = 'translated' | 'turned' | 'identity' | 'raised' | 'direct';
async function fixture(unit: 'metre' | 'millimetre', kind: 'wall' | 'beam', parent: Parent, subject: 'target' | 'boundary', turnedStorey = false) {
  let modelId: string, storey: number;
  if (unit === 'millimetre') {
    const seed = await seedAuthoringSample(); modelId = SAMPLE_MODEL; storey = seed.dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  } else { await seedModelingSession({ unit }); modelId = MODEL_ID; storey = STOREY; }
  const state = useViewerStore.getState(), store = state.models.get(modelId)?.ifcDataStore, view = state.mutationViews.get(modelId);
  assert.ok(store && view);
  const editor = new StoreEditor(store, view), scale = getModelLengthUnitScale(store), factor = 1 / scale;
  const storeyPlacement = store.getEntity(storey)?.attributes[5]; assert.equal(typeof storeyPlacement, 'number');
  if (turnedStorey) {
    const placement = store.getEntity(Number(storeyPlacement)); assert.ok(placement);
    const axisId = Number(placement.attributes[1]), point = editor.addEntity('IfcCartesianPoint', [[200 * factor, -100 * factor, 0]]);
    const direction = editor.addEntity('IfcDirection', [[0, 1, 0]]);
    editor.setPositionalAttribute(axisId, 0, `#${point.expressId}`);
    editor.setPositionalAttribute(axisId, 2, `#${direction.expressId}`);
  }
  const params = { Start: [0, 5, 0] as [number, number, number], End: [8, 5, 0] as [number, number, number], Name: 'Native frame target' };
  const made = kind === 'wall' ? state.addWall(modelId, storey, { ...params, Thickness: .2, Height: 3 }) : state.addBeam(modelId, storey, { ...params, Width: .2, Height: .3 });
  const edge = state.addWall(modelId, storey, { Start: [10, 0, 0], End: [10, 10, 0], Thickness: .2, Height: 3, Name: 'Native frame boundary' });
  assert.ok('expressId' in made && 'expressId' in edge);
  const id = made.expressId, boundary = edge.expressId;
  let parentId = Number(storeyPlacement);
  if (parent !== 'direct') {
    const offset = parent === 'translated' ? [100 * factor, 0, 0] : parent === 'raised' ? [0, 0, 5 * factor] : [0, 0, 0];
    const point = editor.addEntity('IfcCartesianPoint', [offset]), direction = editor.addEntity('IfcDirection', [parent === 'turned' ? [0, 1, 0] : [1, 0, 0]]);
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point.expressId}`, null, `#${direction.expressId}`]);
    parentId = editor.addEntity('IfcLocalPlacement', [`#${storeyPlacement}`, `#${axis.expressId}`]).expressId;
    const placement = resolvePlacementChain(store, view, editor, subject === 'target' ? id : boundary); assert.ok(placement);
    editor.setPositionalAttribute(placement.localPlacementId, 0, `#${parentId}`);
  }
  const source = await parseIfc(editedModelBytes(store, view)), sourceView = new MutablePropertyView(source.properties ?? null, modelId); configureMutationView(sourceView, source);
  const model = state.models.get(modelId); assert.ok(model);
  useViewerStore.setState({ models: new Map([[modelId, { ...model, ifcDataStore: source }]]), mutationViews: new Map([[modelId, sourceView]]), storeEditors: new Map() });
  if (turnedStorey) {
    const placement = source.getEntity(Number(storeyPlacement)); assert.ok(placement);
    const axis = source.getEntity(Number(placement.attributes[1])); assert.ok(axis);
    assert.deepEqual(source.getEntity(Number(axis.attributes[0]))?.attributes[0], [200 * factor, -100 * factor, 0]);
    assert.deepEqual(source.getEntity(Number(axis.attributes[2]))?.attributes[0], [0, 1, 0], 'independent STEP proves an actual translated and rotated storey, not model display metadata');
  }
  const read = nativeAuthoringReach(source, sourceView, new StoreEditor(source, sourceView), id); assert.ok(read);
  const wall = readWallJoinTarget(source, sourceView, boundary, scale); assert.ok(wall);
  if (parent !== 'direct') {
    const attrs = source.getEntity(parentId)?.attributes; assert.ok(attrs); assert.equal(attrs[0], storeyPlacement);
    const axis = source.getEntity(Number(attrs[1])); assert.ok(axis);
    const point = source.getEntity(Number(axis.attributes[0])); assert.ok(point);
    assert.deepEqual(point.attributes[0], parent === 'translated' ? [100 * factor, 0, 0] : parent === 'raised' ? [0, 0, 5 * factor] : [0, 0, 0]);
  }
  const ref = (entityId: number) => ({ modelId, globalId: source.entities.getGlobalId(entityId), ifcClass: source.entities.getTypeName(entityId), name: source.entities.getName(entityId) });
  const op = { op: 'element.trimExtend', mode: 'extend', target: ref(id), expected: read, click: [8, 5], boundary: subject === 'boundary' ? { wall: ref(boundary), expected: wall } : { line: { a: [10, 0], b: [10, 10], tMin: 0, tMax: 1, reach: 0 } } };
  return { source, view: sourceView, id, boundary, modelId, scale, op };
}
function batch(op: unknown, units: 'm' | 'mm' = 'm') {
  return parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native storey frame', units, frame: 'storey-local', operations: [op] }));
}

for (const kind of ['wall', 'beam'] as const) for (const subject of ['target', 'boundary'] as const) for (const parent of ['translated', 'turned'] as const) for (const units of ['m', 'mm'] as const) {
  test(`#7262 ${kind} ${units} refuses a ${parent} native ${subject} parent instead of reinterpreting storey plan coordinates`, async () => {
    const f = await fixture('millimetre', kind, parent, subject), lease = f.view.prepareAtomic(() => null);
    if (kind === 'wall' && subject === 'target' && parent === 'translated') {
      const native = f.view.prepareAtomic(draft => { trimExtendElementInStore(f.source, new StoreEditor(f.source, draft), f.id,
        { mode: 'extend', click: [8, 5], boundary: { a: [10, 0], b: [10, 10], tMin: 0, tMax: 1, reach: 0 } }); return editedModelBytes(f.source, draft); });
      const source = await parseIfc(native.result);
      assert.deepEqual(readWallJoinTarget(source, new MutablePropertyView(source.properties ?? null, f.modelId), f.id, f.scale)?.wall.end, [10, 5], 'native parent-local x10 is storey-local x110, so reviewed storey x10 cannot be passed unchanged');
    }
    const k = units === 'm' ? 1 : 1000;
    const op = { ...f.op, click: [8 * k, 5 * k], boundary: subject === 'boundary' ? f.op.boundary
      : { line: { a: [10 * k, 0], b: [10 * k, 10 * k], tMin: 0, tMax: 1, reach: 0 } } };
    const preview = previewModelAuthoring(useViewerStore.getState(), batch(op, units));
    assert.equal(preview.rows[0].status, 'unsupported', preview.rows[0].issue);
    assert.match(preview.rows[0].issue ?? '', /storey-local/);
    assert.doesNotThrow(() => lease.validate());
    assert.equal(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'native frame refusal').ok, false);
  });
}
for (const unit of ['metre', 'millimetre'] as const) for (const parent of ['direct', 'identity', 'raised'] as const) {
  test(`#7262 ${unit} file preserves supported ${parent} parent under an actual translated/rotated storey`, async () => {
    const f = await fixture(unit, 'wall', parent, 'target', true), lease = f.view.prepareAtomic(() => null);
    const units = unit === 'metre' ? 'm' : 'mm', k = units === 'm' ? 1 : 1000;
    const op = { ...f.op, click: [8 * k, 5 * k], boundary: { line: { a: [10 * k, 0], b: [10 * k, 10 * k], tMin: 0, tMax: 1, reach: 0 } } };
    const preview = previewModelAuthoring(useViewerStore.getState(), batch(op, units)); assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
    assert.doesNotThrow(() => lease.validate());
    const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'native supported storey frame'); assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
    const saved = await parseIfc(editedModelBytes(f.source, f.view));
    assert.deepEqual(readWallJoinTarget(saved, new MutablePropertyView(saved.properties ?? null, f.modelId), f.id, f.scale)?.wall.end, [10, 5]);
    useViewerStore.getState().undo(f.modelId);
    const restored = await parseIfc(editedModelBytes(f.source, f.view));
    assert.deepEqual(readWallJoinTarget(restored, new MutablePropertyView(restored.properties ?? null, f.modelId), f.id, f.scale)?.wall.end, [8, 5]);
  });
}

test('#7262 native committing draft rechecks a preceding parent-frame edit and rolls it back', async () => {
  const f = await fixture('millimetre', 'wall', 'direct', 'target'), proposal = batch(f.op), op = proposal.operations[0]; assert.equal(op.op, 'element.trimExtend');
  if (op.op !== 'element.trimExtend') throw new Error('Expected native Trim/Extend');
  const original = resolvePlacementChain(f.source, f.view, new StoreEditor(f.source, f.view), f.id); assert.ok(original);
  assert.throws(() => recordModellingEdit(useViewerStore, f.modelId, (_methods, draft) => {
    const view = draft.getMutationView(), point = draft.addEntity('IfcCartesianPoint', [[100000, 0, 0]]), axis = draft.addEntity('IfcAxis2Placement3D', [`#${point.expressId}`, null, null]);
    const read = readWallJoinTarget(f.source, view, f.id, f.scale); assert.ok(read);
    const parent = draft.addEntity('IfcLocalPlacement', [`#${read.parentPlacementId}`, `#${axis.expressId}`]);
    draft.setPositionalAttribute(original.localPlacementId, 0, `#${parent.expressId}`);
    const current = nativeAuthoringReach(f.source, view, draft, f.id); assert.ok(current?.kind === 'wall');
    const currentOp = { ...op, expected: { kind: 'wall' as const, snapshot: nativeReachPin(current.wall, 'current native frame') } };
    writeAuthoringReach(proposal, f.source, draft, f.id, currentOp, undefined, new Map());
  }), /storey-local/, 'native writer must not trust a frame proven before a preceding draft edit');
  const saved = await parseIfc(editedModelBytes(f.source, f.view));
  assert.deepEqual(readWallJoinTarget(saved, new MutablePropertyView(saved.properties ?? null, f.modelId), f.id, f.scale)?.wall.end, [8, 5]);
});


test('#7262 native beam writer rechecks an existing boundary parent in its intermediate committing draft', async () => {
  const f = await fixture('millimetre', 'beam', 'direct', 'boundary'), proposal = batch(f.op), op = proposal.operations[0];
  if (op.op !== 'element.trimExtend' || !('wall' in op.boundary)) throw new Error('Expected native wall boundary');
  const wall = op.boundary.wall;
  const placement = resolvePlacementChain(f.source, f.view, new StoreEditor(f.source, f.view), f.boundary); assert.ok(placement);
  assert.throws(() => recordModellingEdit(useViewerStore, f.modelId, (_methods, draft) => {
    const view = draft.getMutationView(), old = readWallJoinTarget(f.source, view, f.boundary, f.scale); assert.ok(old);
    const point = draft.addEntity('IfcCartesianPoint', [[100000, 0, 0]]), axis = draft.addEntity('IfcAxis2Placement3D', [`#${point.expressId}`, null, null]);
    const parent = draft.addEntity('IfcLocalPlacement', [`#${old.parentPlacementId}`, `#${axis.expressId}`]);
    draft.setPositionalAttribute(placement.localPlacementId, 0, `#${parent.expressId}`);
    const current = readWallJoinTarget(f.source, view, f.boundary, f.scale); assert.ok(current);
    const currentOp = { ...op, boundary: { wall, expected: nativeReachPin(current, 'current native boundary') } };
    writeAuthoringReach(proposal, f.source, draft, f.id, currentOp, { id: f.boundary }, new Map());
  }), /storey-local/, 'beam native writes must not interpret a translated wall boundary in the wrong frame');
  const source = await parseIfc(editedModelBytes(f.source, f.view));
  assert.deepEqual(readWallJoinTarget(source, new MutablePropertyView(source.properties ?? null, f.modelId), f.boundary, f.scale)?.wall.start, [10, 0]);
});
