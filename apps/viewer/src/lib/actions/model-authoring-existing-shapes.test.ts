/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { ProfileSection } from '@ifc-lite/create';
import { DEFAULT_SECTIONS, PROFILE_KINDS } from '@/lib/profile-section/profile-kinds';
import { useViewerStore, type ViewerState } from '@/store';
import { applyMaterialLayers, createElementType, setElementDimensions, setElementProfileSection, setElementType } from '@/components/viewer/model-inspector/inspector-edits';
import { layerSetOf } from '@/lib/commands/modeling/authored-kinds';
import { readWallMetres } from '@/store/slices/mutation-wall-resize';
import { readElementProfile } from '@/store/slices/mutation-element-profile';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { GROUND_STOREY, SAMPLE_MODEL, danglingReferences, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { undoModelChanges } from './model-change-commit';
import { readAuthoringSize } from './model-authoring-size';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const s = useViewerStore.getState;
const created = (outcome: { expressId: number } | { error: string }): number => {
  assert.ok('expressId' in outcome, 'error' in outcome ? outcome.error : '');
  return outcome.expressId;
};
const batch = (operation: unknown) => parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native shape edit', units: 'm', frame: 'storey-local', operations: [operation] }));

/** An independently reparsed native export, with no old overlay or singleton registration. */
async function exportedState(): Promise<ViewerState> {
  const state = s(), model = state.models.get(SAMPLE_MODEL)!;
  const bytes = editedModelBytes(model.ifcDataStore!, state.mutationViews.get(SAMPLE_MODEL) ?? null);
  assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
  const store = await parseIfc(bytes);
  return { ...state, models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: store }]]),
    mutationViews: new Map([[SAMPLE_MODEL, new MutablePropertyView(store.properties, SAMPLE_MODEL)]]), storeEditors: new Map() };
}

test('#7229 reviewed wall dimensions admit the native occurrence-layer resize proven by IFC export', async () => {
  const { dataStore } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const wall = created(s().addWall(SAMPLE_MODEL, storey, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: .2, Height: 3, Name: 'Edited wall' }));
  const sibling = created(s().addWall(SAMPLE_MODEL, storey, { Start: [0, 4, 0], End: [4, 4, 0], Thickness: .2, Height: 3, Name: 'Untouched sibling' }));
  const type = createElementType(SAMPLE_MODEL, 'wall', 'Shared native layers', wall);
  assert.ok(type !== null);
  assert.equal(setElementType(SAMPLE_MODEL, sibling, type), true);
  assert.ok(applyMaterialLayers(SAMPLE_MODEL, { kind: 'wall', target: 'type', elementId: wall, typeId: type,
    layers: [{ thickness: .1, material: { name: 'Brick' } }, { thickness: .1, material: { name: 'Plaster' } }] }) !== null);
  const before = await exportedState();
  const beforeStore = before.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  const identity = beforeStore.entities.getGlobalId(wall);
  assert.equal(layerSetOf({ dataStore: beforeStore }, wall)?.via, 'type');
  assert.equal(setElementDimensions(SAMPLE_MODEL, wall, { kind: 'wall', height: 4, thickness: .45 }), true);
  const after = await exportedState();
  const afterStore = after.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  assert.equal(afterStore.entities.getExpressIdByGlobalId(identity), wall);
  const wallSize = readWallMetres(modelEditTarget(after, SAMPLE_MODEL)!, wall);
  assert.equal(wallSize?.height, 4);
  assert.equal(wallSize?.thickness, .45);
  const layers = layerSetOf({ dataStore: afterStore }, wall);
  assert.equal(layers?.via, 'element');
  assert.deepEqual(layers?.layers.map((layer) => layer.thickness), [.1, .35]);
  assert.deepEqual(layerSetOf({ dataStore: afterStore }, sibling)?.layers.map((layer) => layer.thickness), [.1, .1], 'the shared type and sibling retain their native layers');
  const operation = { op: 'element.resize', target: { globalId: identity, ifcClass: 'IfcWall', name: 'Edited wall' },
    expected: { kind: 'wall', height: 4, thickness: .45 }, size: { kind: 'wall', height: 4.5, thickness: .5 } };
  assert.doesNotThrow(() => batch(operation),
  'review must admit the existing native dimension/layer edit');
  const count = s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount();
  const preview = previewModelAuthoring(s(), batch(operation));
  assert.deepEqual(preview.rows.map(row => [row.status, row.issue]), [['ready', undefined]]);
  assert.equal(s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount(), count, 'full geometry/layer draft remains unpublished');
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'native size test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const resized = await exportedState(), resizedStore = resized.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  assert.equal(readWallMetres(modelEditTarget(resized, SAMPLE_MODEL)!, wall)?.height, 4.5);
  assert.equal(readWallMetres(modelEditTarget(resized, SAMPLE_MODEL)!, wall)?.thickness, .5);
  assert.deepEqual(layerSetOf({ dataStore: resizedStore }, wall)?.layers.map(layer => layer.thickness), [.1, .4]);
  assert.deepEqual(layerSetOf({ dataStore: resizedStore }, sibling)?.layers.map(layer => layer.thickness), [.1, .1]);
  assert.deepEqual(undoModelChanges(useViewerStore, outcome.receipt), { ok: true });
  const undone = await exportedState(), undoneStore = undone.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  assert.equal(readWallMetres(modelEditTarget(undone, SAMPLE_MODEL)!, wall)?.height, 4);
  assert.deepEqual(layerSetOf({ dataStore: undoneStore }, wall)?.layers.map(layer => layer.thickness), [.1, .35]);
});

test('#7229 reviewed profile replacement admits the native exported hollow-section edit', async () => {
  const { dataStore } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const beam = created(s().addBeam(SAMPLE_MODEL, storey, { Start: [0, 0, 3], End: [4, 0, 4], Width: .2, Height: .3, Name: 'Native section edit' }));
  const profile = { Type: 'CircleHollow' as const, Radius: .15, WallThickness: .01 };
  assert.equal(setElementProfileSection(SAMPLE_MODEL, beam, profile), true);
  const after = await exportedState();
  const store = after.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  assert.deepEqual(readElementProfile(after, SAMPLE_MODEL, beam), profile, 'independent native STEP readback preserves actual section and millimetre-model conversion');
  const operation = { op: 'element.profile', target: { globalId: store.entities.getGlobalId(beam), ifcClass: 'IfcBeam', name: 'Native section edit' },
    expected: profile, Profile: { Type: 'Circle', Radius: .2 } };
  assert.doesNotThrow(() => batch(operation), 'review must admit the existing native section edit');
  const count = s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount();
  const preview = previewModelAuthoring(s(), batch(operation));
  assert.deepEqual(preview.rows.map(row => [row.status, row.issue]), [['ready', undefined]]);
  assert.equal(s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount(), count, 'native section draft remains unpublished');
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'native section test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  assert.deepEqual(readElementProfile(await exportedState(), SAMPLE_MODEL, beam), { Type: 'Circle', Radius: .2 });
  assert.deepEqual(undoModelChanges(useViewerStore, outcome.receipt), { ok: true });
  assert.deepEqual(readElementProfile(await exportedState(), SAMPLE_MODEL, beam), profile);
});

for (const units of ['m', 'mm']) test(`#7229 all nine native sections replace existing column/beam/member profiles and undo in ${units}`, async () => {
  await seedAuthoringSample();
  const baseline: ProfileSection = { Type: 'Rectangle', XDim: .2, YDim: .3 };
  const creation = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native edit targets', units: 'm', frame: 'storey-local',
    operations: ['IfcColumn', 'IfcBeam', 'IfcMember'].flatMap(ifcClass => PROFILE_KINDS.map((kind, index) => ({
      op: 'element.create', ref: `${ifcClass}-${kind}`, ifcClass, storey: { globalId: GROUND_STOREY }, name: `${ifcClass}-${kind}`,
      params: ifcClass === 'IfcColumn' ? { position: [index * 2, 0, 0], height: 3, Profile: baseline }
        : { start: [index * 2, 0, 3], end: [index * 2 + 1, 3, 4], Profile: baseline },
    }))) }));
  const targets = commitModelAuthoring(useViewerStore, previewModelAuthoring(s(), creation), new Set(creation.operations.map((_, index) => index)), 'native edit targets');
  assert.ok(targets.ok, targets.ok ? '' : targets.detail ?? targets.reason);
  const before = await exportedState();
  const beforeStore = before.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  const factor = units === 'mm' ? 1000 : 1;
  const declared = (profile: ProfileSection) => Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, key === 'Type' ? value : Number(value) * factor]));
  const expected: ProfileSection[] = [];
  const operations = targets.receipt.applied.map((target, index) => {
    const kind = PROFILE_KINDS[index % PROFILE_KINDS.length];
    const profile: ProfileSection = kind === 'Rectangle' ? { Type: 'Rectangle', XDim: .25, YDim: .4 } : DEFAULT_SECTIONS[kind];
    expected.push(profile);
    const id = beforeStore.entities.getExpressIdByGlobalId(target.globalId);
    assert.deepEqual(readElementProfile(before, SAMPLE_MODEL, id), baseline, 'exported precondition is a native rectangular target');
    return { op: 'element.profile', target: { globalId: target.globalId, ifcClass: target.field, name: beforeStore.entities.getName(id) }, expected: declared(baseline), Profile: declared(profile) };
  });
  const proposed = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native section replacements', units, frame: 'storey-local', operations }));
  const count = s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount();
  const preview = previewModelAuthoring(s(), proposed);
  assert.deepEqual(preview.rows.map(row => [row.status, row.issue]), operations.map(() => ['ready', undefined]));
  assert.equal(s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount(), count, 'all native section drafts remain unpublished');
  const committed = commitModelAuthoring(useViewerStore, preview, new Set(preview.rows.map(row => row.index)), 'native sections');
  assert.ok(committed.ok, committed.ok ? '' : committed.detail ?? committed.reason);
  const after = await exportedState(), afterStore = after.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  for (const [index, target] of targets.receipt.applied.entries()) {
    const id = afterStore.entities.getExpressIdByGlobalId(target.globalId);
    assert.equal(id, beforeStore.entities.getExpressIdByGlobalId(target.globalId), 'profile edits preserve existing IFC identity');
    assert.deepEqual(readElementProfile(after, SAMPLE_MODEL, id), expected[index], `${target.field} profile ${index} is the independently exported native section`);
  }
  assert.deepEqual(undoModelChanges(useViewerStore, committed.receipt), { ok: true });
  const undone = await exportedState(), undoneStore = undone.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  for (const target of targets.receipt.applied) assert.deepEqual(readElementProfile(undone, SAMPLE_MODEL, undoneStore.entities.getExpressIdByGlobalId(target.globalId)), baseline, 'one native undo restores every pre-edit section');
});

for (const units of ['m', 'mm']) test(`#7229 native planar thickness and linear dimensions preserve identities and undo in ${units}`, async () => {
  await seedAuthoringSample();
  const classes = ['IfcSlab', 'IfcRoof', 'IfcPlate', 'IfcColumn', 'IfcBeam', 'IfcMember'];
  const creation = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native dimension targets', units: 'm', frame: 'storey-local', operations: classes.map(ifcClass => ({
    op: 'element.create', ref: ifcClass, ifcClass, name: ifcClass, storey: { globalId: GROUND_STOREY },
    params: ['IfcSlab', 'IfcRoof', 'IfcPlate'].includes(ifcClass) ? { position: [0, 0, 0], width: 4, depth: 3, thickness: .2 }
      : ifcClass === 'IfcColumn' ? { position: [0, 0, 0], width: .2, depth: .3, height: 3 }
      : { start: [0, 0, 3], end: [4, 0, 3], width: .2, height: .3 },
  })) }));
  const targets = commitModelAuthoring(useViewerStore, previewModelAuthoring(s(), creation), new Set(classes.map((_, index) => index)), 'native dimension targets');
  assert.ok(targets.ok, targets.ok ? '' : targets.detail ?? targets.reason);
  const before = await exportedState(), beforeStore = before.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  const factor = units === 'mm' ? 1000 : 1;
  const operations = targets.receipt.applied.map((target, index) => {
    const kind = index < 3 ? 'slab' : 'linear';
    const id = beforeStore.entities.getExpressIdByGlobalId(target.globalId);
    const expected = readAuthoringSize(before, SAMPLE_MODEL, id, kind); assert.ok(expected, `actual exported native ${target.field} dimensions`);
    assert.equal(expected.kind, kind);
    return { op: 'element.resize', target: { globalId: target.globalId, ifcClass: target.field, name: beforeStore.entities.getName(id) },
      expected: Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, typeof value === 'number' ? value * factor : value])),
      size: index < 3 ? { kind, thickness: .4 * factor } : { kind, length: 5 * factor, width: .4 * factor, cross: .5 * factor, fixed: index % 2 ? 'start' : 'end' } };
  });
  const proposed = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native dimension edits', units, frame: 'storey-local', operations }));
  const count = s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount();
  const preview = previewModelAuthoring(s(), proposed);
  assert.deepEqual(preview.rows.map(row => [row.status, row.issue]), operations.map(() => ['ready', undefined]));
  assert.equal(s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount(), count, 'native geometry drafts remain unpublished');
  const committed = commitModelAuthoring(useViewerStore, preview, new Set(preview.rows.map(row => row.index)), 'native dimension edits');
  assert.ok(committed.ok, committed.ok ? '' : committed.detail ?? committed.reason);
  const after = await exportedState(), afterStore = after.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  for (const [index, target] of targets.receipt.applied.entries()) {
    const id = afterStore.entities.getExpressIdByGlobalId(target.globalId);
    assert.equal(id, beforeStore.entities.getExpressIdByGlobalId(target.globalId));
    const actual = readAuthoringSize(after, SAMPLE_MODEL, id, index < 3 ? 'slab' : 'linear');
    assert.deepEqual(actual, index < 3 ? { kind: 'slab', thickness: .4 } : { kind: 'linear', length: 5, width: .4, cross: .5, profiled: false }, `${target.field} exported native dimensions`);
  }
  assert.deepEqual(undoModelChanges(useViewerStore, committed.receipt), { ok: true });
  const undone = await exportedState(), undoneStore = undone.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  for (const [index, target] of targets.receipt.applied.entries()) {
    const kind = index < 3 ? 'slab' : 'linear';
    assert.deepEqual(readAuthoringSize(undone, SAMPLE_MODEL, undoneStore.entities.getExpressIdByGlobalId(target.globalId), kind),
      readAuthoringSize(before, SAMPLE_MODEL, beforeStore.entities.getExpressIdByGlobalId(target.globalId), kind), 'one native undo restores original dimensions');
  }
});

test('#7229 stale native edits refuse publication and unchanged native profiles remain no-ops', async () => {
  const { dataStore } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const id = created(s().addBeam(SAMPLE_MODEL, storey, { Start: [0, 0, 3], End: [4, 0, 3], Width: .2, Height: .3, Name: 'Stale native beam' }));
  const saved = await exportedState(), source = saved.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  const baseline = readElementProfile(saved, SAMPLE_MODEL, id); assert.ok(baseline);
  const target = { globalId: source.entities.getGlobalId(id), ifcClass: 'IfcBeam', name: source.entities.getName(id) };
  const profile = { Type: 'Circle' as const, Radius: .2 };
  const preview = previewModelAuthoring(s(), batch({ op: 'element.profile', target, expected: baseline, Profile: profile }));
  assert.equal(preview.rows[0].status, 'ready');
  const changed = { Type: 'CircleHollow' as const, Radius: .3, WallThickness: .02 };
  assert.equal(setElementProfileSection(SAMPLE_MODEL, id, changed), true);
  assert.deepEqual(readElementProfile(await exportedState(), SAMPLE_MODEL, id), changed, 'independent exported native edit changes the approved precondition');
  const count = s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount();
  assert.deepEqual(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'stale native edit'), { ok: false, reason: 'stale' });
  assert.equal(s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount(), count, 'refusal cannot publish a draft');
  assert.deepEqual(readElementProfile(await exportedState(), SAMPLE_MODEL, id), changed);
  const noop = previewModelAuthoring(s(), batch({ op: 'element.profile', target, expected: changed, Profile: changed }));
  assert.equal(noop.rows[0].status, 'unchanged');
  assert.deepEqual(commitModelAuthoring(useViewerStore, noop, new Set([0]), 'unchanged native edit'), { ok: false, reason: 'nothing-approved' });
  assert.equal(s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount(), count);
  const wrongClass = previewModelAuthoring(s(), batch({ op: 'element.profile', target: { ...target, ifcClass: 'IfcColumn' }, expected: changed, Profile: profile }));
  assert.equal(wrongClass.rows[0].status, 'conflict');
  const unsupported = previewModelAuthoring(s(), batch({ op: 'element.resize', target, expected: { kind: 'wall', height: 3, thickness: .2 }, size: { kind: 'wall', height: 4 } }));
  assert.equal(unsupported.rows[0].status, 'invalid', 'native reader refuses a beam represented as wall dimensions');
  assert.equal(s().mutationViews.get(SAMPLE_MODEL)!.getMutationCount(), count);
});

test('#7229 native slab thickness clones inherited layers and scales an otherwise negative final layer', async () => {
  const { dataStore } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const slab = created(s().addSlab(SAMPLE_MODEL, storey, { Profile: 'rectangle', Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: .2, Name: 'Layered native slab' }));
  const sibling = created(s().addSlab(SAMPLE_MODEL, storey, { Profile: 'rectangle', Position: [0, 5, 0], Width: 4, Depth: 3, Thickness: .2, Name: 'Untouched native slab' }));
  const type = createElementType(SAMPLE_MODEL, 'slab', 'Shared slab layers', slab); assert.ok(type !== null);
  assert.equal(setElementType(SAMPLE_MODEL, sibling, type), true);
  assert.ok(applyMaterialLayers(SAMPLE_MODEL, { kind: 'slab', target: 'type', elementId: slab, typeId: type,
    layers: [{ thickness: .1, material: { name: 'Concrete' } }, { thickness: .1, material: { name: 'Finish' } }] }) !== null);
  const before = await exportedState(), beforeStore = before.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  assert.equal(layerSetOf({ dataStore: beforeStore }, slab)?.via, 'type');
  const proposal = batch({ op: 'element.resize', target: { globalId: beforeStore.entities.getGlobalId(slab), ifcClass: 'IfcSlab', name: beforeStore.entities.getName(slab) },
    expected: { kind: 'slab', thickness: .2 }, size: { kind: 'slab', thickness: .05 } });
  const preview = previewModelAuthoring(s(), proposal); assert.equal(preview.rows[0].status, 'ready');
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'native slab layers'); assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const after = await exportedState(), afterStore = after.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  assert.deepEqual(readAuthoringSize(after, SAMPLE_MODEL, slab, 'slab'), { kind: 'slab', thickness: .05 });
  const layers = layerSetOf({ dataStore: afterStore }, slab); assert.equal(layers?.via, 'element');
  assert.deepEqual(layers?.layers.map(layer => layer.thickness), [.025, .025], 'native STEP proves proportional scaling when reducing only the final layer would make it negative');
  assert.deepEqual(layerSetOf({ dataStore: afterStore }, sibling)?.layers.map(layer => layer.thickness), [.1, .1]);
  assert.deepEqual(undoModelChanges(useViewerStore, outcome.receipt), { ok: true });
  const undone = await exportedState(), undoneStore = undone.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  assert.deepEqual(readAuthoringSize(undone, SAMPLE_MODEL, slab, 'slab'), { kind: 'slab', thickness: .2 });
  assert.equal(layerSetOf({ dataStore: undoneStore }, slab)?.via, 'type');
});

test('#7229 explicit model ownership isolates existing profile edits when federated native GUIDs collide', async () => {
  const { dataStore } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const id = created(s().addBeam(SAMPLE_MODEL, storey, { Start: [0, 0, 3], End: [4, 0, 4], Width: .2, Height: .3, Name: 'Federated native beam' }));
  const sourceState = await exportedState(), source = sourceState.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  const second = await parseIfc(editedModelBytes(source, null));
  const model = s().models.get(SAMPLE_MODEL)!;
  const a = { ...model, id: 'a', name: 'a', idOffset: 0, ifcDataStore: source }, b = { ...model, id: 'b', name: 'b', idOffset: 1_000_000, ifcDataStore: second };
  useViewerStore.setState({ models: new Map([['a', a], ['b', b]]), activeModelId: 'a', ifcDataStore: source,
    mutationViews: new Map([['a', new MutablePropertyView(source.properties, 'a')], ['b', new MutablePropertyView(second.properties, 'b')]]), storeEditors: new Map() });
  const baseline = readElementProfile(s(), 'a', id); assert.ok(baseline);
  assert.deepEqual(readElementProfile(s(), 'b', id), baseline, 'both independent native source models contain the same target GUID and baseline section');
  const target = { globalId: source.entities.getGlobalId(id), ifcClass: 'IfcBeam', name: source.entities.getName(id) };
  const profile = { Type: 'CircleHollow' as const, Radius: .3, WallThickness: .02 };
  const ambiguous = previewModelAuthoring(s(), batch({ op: 'element.profile', target, expected: baseline, Profile: profile }));
  assert.notEqual(ambiguous.rows[0].status, 'ready', 'a duplicate federated GUID without model ownership cannot be silently chosen');
  const preview = previewModelAuthoring(s(), batch({ op: 'element.profile', target: { ...target, modelId: 'b' }, expected: baseline, Profile: profile }));
  assert.deepEqual(preview.rows.map(row => [row.status, row.modelId]), [['ready', 'b']]);
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'native federated profile'); assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const readExport = async (modelId: string) => {
    const model = s().models.get(modelId)!;
    const bytes = editedModelBytes(model.ifcDataStore!, s().mutationViews.get(modelId)!);
    assert.deepEqual(danglingReferences(new TextDecoder().decode(bytes)), []);
    const store = await parseIfc(bytes);
    const state = { ...s(), models: new Map([[modelId, { ...model, ifcDataStore: store }]]), mutationViews: new Map([[modelId, new MutablePropertyView(store.properties, modelId)]]), storeEditors: new Map() };
    return readElementProfile(state, modelId, id);
  };
  assert.deepEqual(await readExport('a'), baseline, 'source model a remains unchanged in native STEP');
  assert.deepEqual(await readExport('b'), profile, 'explicit model b alone has the edited native STEP profile');
  assert.deepEqual(undoModelChanges(useViewerStore, outcome.receipt), { ok: true });
  assert.deepEqual(await readExport('b'), baseline);
});

test('#7229 expected native dimensions admit a small existing source member without applying creation minima', async () => {
  const { dataStore } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const id = created(s().addBeam(SAMPLE_MODEL, storey, { Start: [0, 0, 0], End: [.02, 0, 0], Width: .02, Height: .03, Name: 'Small native beam' }));
  const before = await exportedState(), source = before.models.get(SAMPLE_MODEL)!.ifcDataStore!;
  const expected = readAuthoringSize(before, SAMPLE_MODEL, id, 'linear');
  assert.deepEqual(expected, { kind: 'linear', length: .02, width: .02, cross: .03, profiled: false });
  assert.equal(setElementDimensions(SAMPLE_MODEL, id, { kind: 'linear', length: .1 }), true);
  assert.deepEqual(readAuthoringSize(await exportedState(), SAMPLE_MODEL, id, 'linear'), { ...expected, length: .1 }, 'native inspector authorability is independently exported');
  assert.equal(setElementDimensions(SAMPLE_MODEL, id, { kind: 'linear', length: .02 }), true);
  const proposal = batch({ op: 'element.resize', target: { globalId: source.entities.getGlobalId(id), ifcClass: 'IfcBeam', name: source.entities.getName(id) },
    expected, size: { kind: 'linear', length: .1 } });
  const preview = previewModelAuthoring(s(), proposal);
  assert.equal(preview.rows[0].status, 'ready', 'the expected snapshot describes existing native geometry, not a proposed creation');
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'small native member');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  assert.deepEqual(readAuthoringSize(await exportedState(), SAMPLE_MODEL, id, 'linear'), { ...expected, length: .1 });
  assert.deepEqual(undoModelChanges(useViewerStore, outcome.receipt), { ok: true });
  assert.deepEqual(readAuthoringSize(await exportedState(), SAMPLE_MODEL, id, 'linear'), expected);
});
