/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { createElement, act } from 'react';
import { render, click, cleanup } from '@/test/render';
import { ModelAuthoringReview } from '@/components/viewer/actions/ModelAuthoringReview';
import { modelChangeLibrary } from './receipts';
import { afterEach, test } from 'node:test';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { addOpeningToStore, resolveHostAnchor, splitElementsInStore } from '@ifc-lite/create';
import { extractPropertiesOnDemand, extractRelationshipsOnDemand } from '@ifc-lite/parser';
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
afterEach(() => { cleanup(); useViewerStore.setState(original); });
const s = useViewerStore.getState;
const created = (value: { expressId: number } | { error: string }) => {
  assert.ok('expressId' in value, 'error' in value ? value.error : '');
  return value.expressId;
};

for (const units of ['m', 'mm'] as const) for (const kind of ['wall', 'linear', 'column', 'member', 'slab'] as const) test(`#7251 reviewed ${units} ${kind} split admits independently exported native split effects`, async () => {
  const { dataStore } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const profile = { Type: 'RectangleHollow' as const, XDim: .2, YDim: .4, WallThickness: .02 };
  const id = kind === 'wall'
    ? created(s().addWall(SAMPLE_MODEL, storey, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: .2, Height: 3, Name: 'Native split wall' }))
    : kind === 'linear' || kind === 'column' || kind === 'member'
      ? created(s().addBeam(SAMPLE_MODEL, storey, { Start: [0, 8, 1], End: [8, 8, 3], Profile: profile, Name: 'Native rolled split beam' }))
      : created(s().addSlab(SAMPLE_MODEL, storey, { Profile: 'polygon', OuterCurve: [[0, 0], [8, 0], [8, 3], [4, 3], [4, 6], [0, 6]], Position: [0, 16, 0], Thickness: .2, Name: 'Native split slab' }));
  if (kind === 'column' || kind === 'member') {
    const edit = modelEditTarget(s(), SAMPLE_MODEL)!;
    edit.editor.setEntityType(id, kind === 'column' ? 'IfcColumn' : 'IfcMember');
  }
  if (kind === 'linear' || kind === 'column' || kind === 'member') {
    const edit = modelEditTarget(s(), SAMPLE_MODEL)!;
    const placement = resolvePlacementChain(edit.dataStore, edit.view, edit.editor, id); assert.ok(placement);
    const direction = edit.editor.addEntity('IfcDirection', [[0, 1, 0]]).expressId;
    edit.editor.setPositionalAttribute(placement.axisPlacementId, 2, `#${direction}`);
  }
  const authored = editedModelBytes(dataStore, s().mutationViews.get(SAMPLE_MODEL)!);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(authored)), []);
  const source = await parseIfc(authored), view = new MutablePropertyView(source.properties, SAMPLE_MODEL), editor = new StoreEditor(source, view);
  const splitKind = kind === 'column' || kind === 'member' ? 'linear' : kind;
  const scale = getModelLengthUnitScale(source), gate = resolveSplitTarget(source, view, editor, id, scale);
  assert.ok(gate.ok && gate.kind === splitKind, 'the independently saved public-authored native source is splittable');
  const guid = source.entities.getGlobalId(id);
  const cut = splitKind === 'slab' ? { kind: splitKind, a: [2, 15] as [number, number], b: [2, 23] as [number, number] } : { kind: splitKind, distance: 2 };
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
  } else if (splitKind === 'linear') {
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
  assert.equal(previewModelAuthoring(s(), proposal).rows[0].status, 'ambiguous-target', 'live public positional GUID edits must be just as ambiguous as their independently parsed export');
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

test('#7251 explicit two-model selection splits equal native GUIDs without cross-model effects and undoes once', async () => {
  const { dataStore, native, id, proposal } = await wallProposal();
  const model = s().models.get(SAMPLE_MODEL)!;
  const peerId = 'native-split-peer', peerView = new MutablePropertyView(native.properties, peerId);
  const firstView = s().mutationViews.get(SAMPLE_MODEL)!;
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, model], [peerId, { ...model, id: peerId, idOffset: 1_000_000, ifcDataStore: native }]]),
    mutationViews: new Map([[SAMPLE_MODEL, firstView], [peerId, peerView]]), storeEditors: new Map() });
  const first = proposal.operations[0]; assert.ok(first.op === 'element.split');
  const peer = { ...first, target: { ...first.target, modelId: peerId } };
  const batch = parseModelAuthoringBatch(JSON.stringify({ ...proposal, operations: [first, peer] }));
  const preview = previewModelAuthoring(s(), batch);
  assert.deepEqual(preview.rows.map(row => row.status), ['ready', 'ready']);
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0, 1]), 'federated native split');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const addedGuids: string[] = [];
  for (const [modelId, source] of [[SAMPLE_MODEL, dataStore], [peerId, native]] as const) {
    const parsed = await parseIfc(editedModelBytes(source, s().mutationViews.get(modelId)!));
    const view = new MutablePropertyView(parsed.properties, modelId), editor = new StoreEditor(parsed, view);
    const target = resolveSplitTarget(parsed, view, editor, id, getModelLengthUnitScale(parsed));
    assert.ok(target.ok && target.kind === 'wall'); assert.equal(target.chain.wallLength, 6);
    const effect = outcome.receipt.applied.find(row => row.modelId === modelId);
    assert.ok(effect && typeof effect.after === 'string');
    const decoded: unknown = JSON.parse(effect.after);
    assert.ok(decoded && typeof decoded === 'object' && 'addedGlobalId' in decoded && typeof decoded.addedGlobalId === 'string');
    addedGuids.push(decoded.addedGlobalId);
    assert.ok(parsed.entities.getExpressIdByGlobalId(decoded.addedGlobalId) > 0);
  }
  assert.notEqual(addedGuids[0], addedGuids[1], 'canonical peer GUID scopes distinguish the two newly authored pieces');
  assert.deepEqual(undoModelChanges(useViewerStore, outcome.receipt), { ok: true });
  for (const [modelId, source] of [[SAMPLE_MODEL, dataStore], [peerId, native]] as const) {
    const parsed = await parseIfc(editedModelBytes(source, s().mutationViews.get(modelId)!));
    const view = new MutablePropertyView(parsed.properties, modelId), editor = new StoreEditor(parsed, view);
    const target = resolveSplitTarget(parsed, view, editor, id, getModelLengthUnitScale(parsed));
    assert.ok(target.ok && target.kind === 'wall'); assert.equal(target.chain.wallLength, 8);
    for (const guid of addedGuids) assert.equal(parsed.entities.getExpressIdByGlobalId(guid), -1);
  }
});


test('#7251 mounted review discloses cut marker limits and applies only the selected native split', async () => {
  await modelChangeLibrary.initialize();
  const { dataStore, proposal, id } = await wallProposal();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const otherId = created(s().addWall(SAMPLE_MODEL, storey, { Start: [0, 10, 0], End: [5, 10, 0], Thickness: .3, Height: 4, Name: 'Excluded native wall' }));
  const source = await parseIfc(editedModelBytes(dataStore, s().mutationViews.get(SAMPLE_MODEL)!));
  const sourceView = new MutablePropertyView(source.properties, SAMPLE_MODEL), editor = new StoreEditor(source, sourceView);
  const first = proposal.operations[0]; assert.ok(first.op === 'element.split');
  const batch = parseModelAuthoringBatch(JSON.stringify({ ...proposal, operations: [first, { ...first,
    target: { ...first.target, globalId: source.entities.getGlobalId(otherId), name: source.entities.getName(otherId) },
    expected: readSplitSnapshot(source, editor, otherId, 'm') }] }));
  const view = s().mutationViews.get(SAMPLE_MODEL)!, count = view.getMutationCount();
  const ui = render(createElement(ModelAuthoringReview, { batch, origin: 'native split review' }));
  assert.match(ui.textContent ?? '', /length=8, height=3, thickness=0.2 m/);
  assert.match(ui.textContent ?? '', /Preview shows the cut marker, not the resulting solids/);
  assert.match(ui.textContent ?? '', /structural engineering intent/);
  assert.equal(view.getMutationCount(), count);
  const boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]; assert.equal(boxes.length, 2);
  act(() => boxes[1].click());
  const apply = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Apply 1 operation'); assert.ok(apply);
  await act(async () => { click(apply); }); assert.match(ui.textContent ?? '', /Applied 1 change/);
  const parsed = await parseIfc(editedModelBytes(dataStore, view)), parsedView = new MutablePropertyView(parsed.properties, SAMPLE_MODEL), parsedEditor = new StoreEditor(parsed, parsedView);
  for (const [target, length] of [[id, 6], [otherId, 5]]) {
    const native = resolveSplitTarget(parsed, parsedView, parsedEditor, target, getModelLengthUnitScale(parsed));
    assert.ok(native.ok && native.kind === 'wall'); assert.equal(native.chain.wallLength, length);
  }
});


for (const transport of ['live', 'saved'] as const) test(`#7251 native ${transport} property membership and hosted openings survive reviewed split and grouped undo`, async () => {
  const { dataStore, proposal, id } = await wallProposal();
  const ctx = modelEditTarget(s(), SAMPLE_MODEL)!;
  ctx.view.setProperty(id, 'SplitEvidence', 'Witness', 'Independent native metadata');
  const opening = addOpeningToStore(ctx.editor, resolveHostAnchor(dataStore, id, ctx.view), { Offset: 1, Sill: .5, Width: 1, Height: 1.5, Name: 'Native retained opening' });
  const source = await parseIfc(editedModelBytes(dataStore, ctx.view));
  const originalProperties = extractPropertiesOnDemand(source, id);
  assert.ok(originalProperties.some(set => set.name === 'SplitEvidence'), 'public writer exported actual property membership before review');
  assert.ok(extractRelationshipsOnDemand(source, id).voids.some(row => row.id === opening.openingId), 'independent parse proves the native voiding association');
  if (transport === 'live') {
    const nativeProbe = ctx.view.prepareAtomic(draft => {
      const [nativeResult] = splitElementsInStore(dataStore, new StoreEditor(dataStore, draft), [{ expressId: id, cut: { kind: 'wall', distance: 2 } }]);
      return { addedId: nativeResult.addedId, bytes: editedModelBytes(dataStore, draft) };
    }).result;
    const nativeExport = await parseIfc(nativeProbe.bytes);
    assert.ok(extractPropertiesOnDemand(nativeExport, nativeProbe.addedId).some(set => set.name === 'SplitEvidence'),
      'the shared native split must carry a live virtual Pset just as its saved source counterpart does');
  }
  const sourceModel = s().models.get(SAMPLE_MODEL)!;
  const activeSource = transport === 'saved' ? source : dataStore;
  const activeView = transport === 'saved' ? new MutablePropertyView(source.properties, SAMPLE_MODEL) : ctx.view;
  if (transport === 'saved') useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...sourceModel, ifcDataStore: source }]]),
    mutationViews: new Map([[SAMPLE_MODEL, activeView]]), storeEditors: new Map() });
  const preview = previewModelAuthoring(s(), proposal); assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
  assert.equal(preview.rows[0].resolved.splitEffects?.openings.toLeft, 1);
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'hosted native split');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const after = await parseIfc(editedModelBytes(activeSource, activeView));
  const applied = outcome.receipt.applied[0]; assert.equal(typeof applied.after, 'string');
  const effect: unknown = JSON.parse(String(applied.after));
  assert.ok(effect && typeof effect === 'object' && 'addedGlobalId' in effect && typeof effect.addedGlobalId === 'string');
  const addedId = after.entities.getExpressIdByGlobalId(effect.addedGlobalId); assert.ok(addedId > 0);
  for (const piece of [id, addedId]) {
    const set = extractPropertiesOnDemand(after, piece).find(set => set.name === 'SplitEvidence');
    const originalSet = originalProperties.find(set => set.name === 'SplitEvidence');
    assert.ok(set && originalSet); assert.deepEqual(set.properties, originalSet.properties);
    if (transport === 'saved') assert.equal(set.globalId, originalSet.globalId, 'saved source membership retains its actual property set identity');
  }
  assert.ok(extractRelationshipsOnDemand(after, addedId).voids.some(row => row.id === opening.openingId));
  assert.equal(extractRelationshipsOnDemand(after, id).voids.length, 0);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(editedModelBytes(activeSource, activeView))), []);
  assert.deepEqual(undoModelChanges(useViewerStore, outcome.receipt), { ok: true });
  const undone = await parseIfc(editedModelBytes(activeSource, activeView));
  assert.deepEqual(extractPropertiesOnDemand(undone, id).map(({ name, properties }) => ({ name, properties })), originalProperties.map(({ name, properties }) => ({ name, properties })));
  if (transport === 'saved') assert.deepEqual(extractPropertiesOnDemand(undone, id), originalProperties);
  assert.ok(extractRelationshipsOnDemand(undone, id).voids.some(row => row.id === opening.openingId));
});
