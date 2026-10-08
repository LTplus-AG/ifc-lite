/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { splitElementsInStore } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { resolveSplitTarget } from '@/lib/split-target';
import { resolvePlacementChain } from '@/lib/placement-core';
import { readElementProfile } from '@/store/slices/mutation-element-profile';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { GROUND_STOREY, SAMPLE_MODEL, danglingReferences, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const s = useViewerStore.getState;
const created = (value: { expressId: number } | { error: string }) => {
  assert.ok('expressId' in value, 'error' in value ? value.error : '');
  return value.expressId;
};

for (const kind of ['wall', 'linear', 'slab'] as const) test(`#7251 reviewed ${kind} split admits independently exported native split effects`, async () => {
  const { dataStore } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const profile = { Type: 'RectangleHollow' as const, XDim: .2, YDim: .4, WallThickness: .02 };
  const id = kind === 'wall'
    ? created(s().addWall(SAMPLE_MODEL, storey, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: .2, Height: 3, Name: 'Native split wall' }))
    : kind === 'linear'
      ? created(s().addBeam(SAMPLE_MODEL, storey, { Start: [0, 8, 1], End: [8, 8, 3], Profile: profile, Name: 'Native rolled split beam' }))
      : created(s().addSlab(SAMPLE_MODEL, storey, { Profile: 'polygon', OuterCurve: [[0, 0], [8, 0], [8, 3], [4, 3], [4, 6], [0, 6]], Position: [0, 16, 0], Thickness: .2, Name: 'Native split slab' }));
  if (kind === 'linear') {
    const edit = modelEditTarget(s(), SAMPLE_MODEL)!;
    const placement = resolvePlacementChain(edit.dataStore, edit.view, edit.editor, id); assert.ok(placement);
    const direction = edit.editor.addEntity('IfcDirection', [[0, 1, 0]]).expressId;
    edit.editor.setPositionalAttribute(placement.axisPlacementId, 2, `#${direction}`);
  }
  const authored = editedModelBytes(dataStore, s().mutationViews.get(SAMPLE_MODEL)!);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(authored)), []);
  const source = await parseIfc(authored), view = new MutablePropertyView(source.properties, SAMPLE_MODEL), editor = new StoreEditor(source, view);
  const scale = getModelLengthUnitScale(source), gate = resolveSplitTarget(source, view, editor, id, scale);
  assert.ok(gate.ok && gate.kind === kind, 'the independently saved public-authored native source is splittable');
  const guid = source.entities.getGlobalId(id);
  const cut = kind === 'slab' ? { kind, a: [2, 15] as [number, number], b: [2, 23] as [number, number] } : { kind, distance: 2 };
  const [result] = splitElementsInStore(source, editor, [{ expressId: id, cut }]);
  assert.equal(result.sourceId, id); assert.notEqual(result.addedId, id);
  const saved = editedModelBytes(source, view); assert.deepEqual(danglingReferences(new TextDecoder().decode(saved)), []);
  const after = await parseIfc(saved), empty = new MutablePropertyView(after.properties, SAMPLE_MODEL), afterEditor = new StoreEditor(after, empty);
  assert.equal(after.entities.getExpressIdByGlobalId(guid), id, 'the larger native piece retains its original identity');
  assert.notEqual(after.entities.getGlobalId(result.addedId), guid, 'exactly one native new root has a derived identity');
  const left = resolveSplitTarget(after, empty, afterEditor, result.leftId, scale), right = resolveSplitTarget(after, empty, afterEditor, result.rightId, scale);
  assert.ok(left.ok && right.ok, 'both independent native exports remain readable supported split targets');
  if (kind === 'wall') {
    assert.ok(left.kind === 'wall' && right.kind === 'wall');
    assert.ok(Math.abs(left.chain.wallLength - 2) < 1e-9 && Math.abs(right.chain.wallLength - 6) < 1e-9);
  } else if (kind === 'linear') {
    assert.ok(left.kind === 'linear' && right.kind === 'linear');
    assert.ok(Math.abs(left.chain.depth - 2) < 1e-9 && Math.abs(left.chain.depth + right.chain.depth - Math.hypot(8, 2)) < 1e-9);
    const state = { ...s(), models: new Map([[SAMPLE_MODEL, { ...s().models.get(SAMPLE_MODEL)!, ifcDataStore: after }]]), mutationViews: new Map([[SAMPLE_MODEL, empty]]), storeEditors: new Map() };
    assert.deepEqual(readElementProfile(state, SAMPLE_MODEL, result.leftId), profile);
    assert.deepEqual(readElementProfile(state, SAMPLE_MODEL, result.rightId), profile);
  }
  // #7251: native writer/export preconditions above must pass before the
  // reviewed-contract omission is asserted. No mock can supply these effects.
  assert.doesNotThrow(() => parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native split', units: 'm', frame: 'storey-local',
    operations: [{ op: 'element.split', target: { modelId: SAMPLE_MODEL, globalId: guid, ifcClass: source.entities.getTypeName(id), name: source.entities.getName(id) }, expected: {}, cut }] })),
  'the reviewed contract must admit the canonical native split, before native dry-run decides authorability');
});
