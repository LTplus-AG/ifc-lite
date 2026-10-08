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
import { authoringSplitMarker } from './model-authoring-split-ghost';
import { readSplitSnapshot } from './model-authoring-split-state';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';
import { parseModelAuthoringBatch } from './model-authoring';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const s = useViewerStore.getState;
const created = (value: { expressId: number } | { error: string }) => {
  assert.ok('expressId' in value, 'error' in value ? value.error : '');
  return value.expressId;
};

for (const units of ['m', 'mm'] as const) for (const kind of ['wall', 'linear', 'slab'] as const) test(`#7251 reviewed ${units} ${kind} split admits independently exported native split effects`, async () => {
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
  const expected = readSplitSnapshot(source, editor, id, units);
  const reviewedCut = units === 'm' ? cut : cut.kind === 'slab' ? { kind: cut.kind, a: cut.a.map(v => v * 1000), b: cut.b.map(v => v * 1000) } : { kind: cut.kind, distance: cut.distance * 1000 };
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
  assert.doesNotThrow(() => parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native split', units, frame: 'storey-local',
    operations: [{ op: 'element.split', target: { modelId: SAMPLE_MODEL, globalId: guid, ifcClass: source.entities.getTypeName(id), name: source.entities.getName(id) }, expected, cut: reviewedCut }] })),
  'the reviewed contract must admit the canonical native split, before native dry-run decides authorability');
  const proposal = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Reviewed native split', units, frame: 'storey-local',
    operations: [{ op: 'element.split', target: { modelId: SAMPLE_MODEL, globalId: guid, ifcClass: source.entities.getTypeName(id), name: source.entities.getName(id) }, expected, cut: reviewedCut }] }));
  const beforeView = s().mutationViews.get(SAMPLE_MODEL)!;
  const count = beforeView.getMutationCount();
  const preview = previewModelAuthoring(s(), proposal);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
  assert.ok(authoringSplitMarker(s(), proposal, preview.rows[0], 123456), 'supported native storey frame exposes a cut marker, not split solids');
  assert.equal(beforeView.getMutationCount(), count, 'native dry-run cannot publish source reshaping or a new piece');
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'native split test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const reviewed = await parseIfc(editedModelBytes(dataStore, s().mutationViews.get(SAMPLE_MODEL)!));
  assert.equal(reviewed.entities.getGlobalId(id), guid);
  assert.equal(reviewed.entities.getGlobalId(result.addedId), after.entities.getGlobalId(result.addedId), 'review reuses the actual canonical derived-GUID policy');
  const reviewedView = new MutablePropertyView(reviewed.properties, SAMPLE_MODEL), reviewedEditor = new StoreEditor(reviewed, reviewedView);
  for (const piece of [result.leftId, result.rightId]) {
    assert.deepEqual(resolveSplitTarget(reviewed, reviewedView, reviewedEditor, piece, scale), resolveSplitTarget(after, empty, afterEditor, piece, scale), 'reviewed export preserves independently decoded native geometry and provenance');
    assert.deepEqual(resolvePlacementChain(reviewed, reviewedView, reviewedEditor, piece), resolvePlacementChain(after, empty, afterEditor, piece), 'reviewed export preserves the canonical source frame and section roll');
  }
  assert.deepEqual(undoModelChanges(useViewerStore, outcome.receipt), { ok: true });
  const undone = await parseIfc(editedModelBytes(dataStore, s().mutationViews.get(SAMPLE_MODEL)!));
  assert.equal(undone.entities.getExpressIdByGlobalId(after.entities.getGlobalId(result.addedId)), -1);
  assert.equal(undone.entities.getGlobalId(id), guid);
  const undoneView = new MutablePropertyView(undone.properties, SAMPLE_MODEL);
  assert.deepEqual(readSplitSnapshot(undone, new StoreEditor(undone, undoneView), id, units), expected, 'one grouped undo restores the full independently decoded native shape and placement');
});

async function wallProposal() {
  const { dataStore } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const id = created(s().addWall(SAMPLE_MODEL, storey, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: .2, Height: 3, Name: 'Pinned native wall' }));
  const native = await parseIfc(editedModelBytes(dataStore, s().mutationViews.get(SAMPLE_MODEL)!));
  const view = new MutablePropertyView(native.properties, SAMPLE_MODEL), editor = new StoreEditor(native, view);
  const op = { op: 'element.split', target: { modelId: SAMPLE_MODEL, globalId: native.entities.getGlobalId(id), ifcClass: native.entities.getTypeName(id), name: native.entities.getName(id) },
    expected: readSplitSnapshot(native, editor, id, 'm'), cut: { kind: 'wall', distance: 2 } };
  const proposal = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Pinned split', units: 'm', frame: 'storey-local', operations: [op] }));
  return { dataStore, id, native, proposal, op };
}

test('#7251 refuses stale actual source transport and revision without publishing a split', async () => {
  const { dataStore, id, proposal } = await wallProposal();
  const preview = previewModelAuthoring(s(), proposal); assert.equal(preview.rows[0].status, 'ready');
  const model = s().models.get(SAMPLE_MODEL)!;
  assert.ok(dataStore.source);
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: { ...dataStore, source: dataStore.source.slice() } }]]) });
  const view = s().mutationViews.get(SAMPLE_MODEL)!, count = view.getMutationCount();
  const swapped = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'source replacement');
  assert.ok(!swapped.ok && swapped.reason === 'stale'); assert.equal(view.getMutationCount(), count);
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, model]]) });
  const fresh = previewModelAuthoring(s(), proposal); assert.equal(fresh.rows[0].status, 'ready');
  const edit = modelEditTarget(s(), SAMPLE_MODEL)!;
  edit.editor.setPositionalAttribute(id, 3, 'A real native overlay revision after review');
  const revisionCount = view.getMutationCount();
  const changed = commitModelAuthoring(useViewerStore, fresh, new Set([0]), 'revision replacement');
  assert.ok(!changed.ok && changed.reason === 'stale'); assert.equal(view.getMutationCount(), revisionCount);
  const exported = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(exported.getEntity(id)?.attributes[3], 'A real native overlay revision after review');
  const uneditedView = new MutablePropertyView(exported.properties, SAMPLE_MODEL);
  const target = resolveSplitTarget(exported, uneditedView, new StoreEditor(exported, uneditedView), id, getModelLengthUnitScale(exported));
  assert.ok(target.ok && target.kind === 'wall'); assert.equal(target.chain.wallLength, 8);
});

test('#7251 a source-exported same-model duplicate GlobalId cannot select one wall silently', async () => {
  const { dataStore, id, proposal } = await wallProposal();
  const edit = modelEditTarget(s(), SAMPLE_MODEL)!;
  const duplicate = created(s().addWall(SAMPLE_MODEL, dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY), { Start: [0, 10, 0], End: [5, 10, 0], Thickness: .3, Height: 4, Name: 'Other malformed native wall' }));
  edit.editor.setPositionalAttribute(duplicate, 0, proposal.operations[0].op === 'element.split' ? proposal.operations[0].target.globalId : '');
  const source = await parseIfc(editedModelBytes(dataStore, edit.view));
  assert.equal(source.entities.getGlobalId(id), source.entities.getGlobalId(duplicate));
  assert.notEqual(source.entities.getName(id), source.entities.getName(duplicate));
  const model = s().models.get(SAMPLE_MODEL)!;
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: source }]]),
    mutationViews: new Map([[SAMPLE_MODEL, new MutablePropertyView(source.properties, SAMPLE_MODEL)]]), storeEditors: new Map() });
  const count = s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount();
  const preview = previewModelAuthoring(s(), proposal);
  assert.equal(preview.rows[0].status, 'ambiguous-target');
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'malformed identity');
  assert.equal(result.ok, false); assert.equal(s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount(), count);
});

test('#7251 malformed slab snapshot refuses before footprint work instead of throwing a raw TypeError', async () => {
  const { op } = await wallProposal();
  const batch = (expected: unknown) => JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Malformed snapshot', units: 'm', frame: 'storey-local', operations: [{ ...op, cut: { kind: 'slab', a: [0, 0], b: [0, 1] }, expected }] });
  for (const footprint of [undefined, [], [[0, 0]], Array.from({ length: 257 }, () => [0, 0]), [[0, 0], [1, 0], ['bad', 1]]]) {
    assert.throws(() => parseModelAuthoringBatch(batch({ ...op.expected, kind: 'slab', chain: { footprint } })), /finite native footprint/);
  }
});
