/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { assertSameNativeIfcGraph } from '@/test/native-ifc-graph';
import { afterEach, test } from 'node:test';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { readRelatedLists } from '@ifc-lite/create';
import { EMPTY_SOURCE_BYTES, effectiveMetadataRecord, extractAllMaterialsOnDemand, extractMaterialsOnDemand, getAttributeNamesForSchema } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { applyMaterialLayers } from '@/components/viewer/model-inspector/inspector-edits';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { layerSetOf, readLayerSet } from '@/lib/commands/modeling/authored-kinds';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { BACK_WALL, FRONT_WALL_TYPE, GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { readOnlyModelEditTarget } from './model-authoring-read-target';
import { readAuthoringSizeFromTarget } from './model-authoring-size';
import type { NativeLayerEvidence, NativeLayerExpected } from './native-layer-evidence';
import { captureSelectionGrounding } from './selection-grounding';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { captureEvidence } from '@/lib/assistant/evidence';
import { cancelAssistant, replaceEvidence, useAssistant } from '@/lib/assistant/conversation';
import { sendAssistant } from '@/lib/assistant/request';

const original = useViewerStore.getState();
const originalAssistant = useAssistant.getState(), originalFetch = globalThis.fetch;
const WALL_NAME = 'Native layer wall';
afterEach(() => { cancelAssistant(); globalThis.fetch = originalFetch; useAssistant.setState(originalAssistant, true); useViewerStore.setState(original, true); });

/** Endpoint-only witness: a complete production revert reaches assertions, not missing new-module imports. */
function transportedLayerEvidence(state: ReturnType<typeof useViewerStore.getState>, target: number): NativeLayerEvidence {
  const grounding = captureSelectionGrounding({ ...state, selectedEntityIds: new Set([target]) });
  const evidence = grounding.elements[0]?.nativeLayers;
  assert.ok(evidence, '#7275 actual native selection capture must publish layer grounding');
  return evidence;
}

async function inspectorControl() {
  const { dataStore, view } = await seedAuthoringSample();
  const create = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native wall prerequisite',
    units: 'm', frame: 'storey-local', operations: [{ op: 'element.create', ref: 'wall', ifcClass: 'IfcWall',
      storey: { globalId: GROUND_STOREY }, name: WALL_NAME,
      params: { start: [10, 10, 0], end: [14, 10, 0], thickness: .2, height: 3 } }] }));
  const created = commitModelAuthoring(useViewerStore, previewModelAuthoring(useViewerStore.getState(), create), new Set([0]), 'test');
  assert.ok(created.ok, created.ok ? '' : created.detail ?? created.reason);
  const globalId = created.receipt.applied[0].globalId;
  const createdSource = await parseIfc(editedModelBytes(dataStore, view));
  const target = createdSource.entities.getExpressIdByGlobalId(globalId);
  assert.ok(target > 0);
  assert.equal(createdSource.entities.getName(target), WALL_NAME, 'native wall creation survives independent STEP before layer assignment');
  const setId = applyMaterialLayers(SAMPLE_MODEL, { kind: 'wall', target: 'element', elementId: target, typeId: null,
    layers: [{ thickness: .25, material: { name: 'Explicit masonry' } }, { thickness: .05, material: { name: 'Explicit finish' } }] });
  assert.ok(setId !== null, 'real inspector action must accept the native wall in the committed SketchUp model');
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const parsedView = new MutablePropertyView(parsed.properties ?? null, SAMPLE_MODEL);
  const layers = layerSetOf({ dataStore: parsed, view: parsedView }, target);
  assert.ok(layers);
  assert.equal(layers.via, 'element');
  assert.deepEqual(layers.layers.map(layer => [parsed.getEntity(layer.materialId!)?.attributes[0], layer.thickness]),
    [['Explicit masonry', .25], ['Explicit finish', .05]], 'independent STEP reparse proves layer order, native non-root material Names and SI thickness');
  assert.equal(parsed.entities.getGlobalId(target), globalId);
  assert.equal(parsed.entities.getName(target), WALL_NAME);
  const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  const readState = { ...useViewerStore.getState(), models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: parsed }]]),
    mutationViews: new Map([[SAMPLE_MODEL, parsedView]]), storeEditors: new Map() };
  const readTarget = readOnlyModelEditTarget(readState, SAMPLE_MODEL);
  assert.ok(readTarget);
  const size = readAuthoringSizeFromTarget(readTarget, target, 'wall');
  assert.ok(size?.kind === 'wall', 'the native wall reader retains its wall discriminator');
  assert.equal(size.thickness, .3,
    'the actual native wall body is resized to the layer total, in metres despite the IFC millimetre source');
  return { dataStore, view, target, globalId, layers };
}

test('#7275 native inspector layers export ordered materials and resize the actual committed wall', async () => {
  await inspectorControl();
});

test('#7275 reviewed native layer assignment admits explicit ordered layers and non-root material references', async () => {
  const { dataStore, view, target, layers, globalId } = await inspectorControl();
  const state = useViewerStore.getState();
  const expected = transportedLayerEvidence(state, target).expected;
  assert.ok(expected);
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Explicit native layers',
    units: 'm', frame: 'storey-local', operations: [{ op: 'material.layers',
      target: { globalId, modelId: SAMPLE_MODEL, ifcClass: 'IfcWall', name: WALL_NAME }, scope: 'element', expected,
      MaterialLayers: [{ LayerThickness: .2, Material: { modelId: SAMPLE_MODEL, expressId: layers.layers[0].materialId, Name: 'Explicit masonry' } },
        { LayerThickness: .1, Material: null }],
    }] }));
  const preview = previewModelAuthoring(state, batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
  assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const current = layerSetOf({ dataStore: parsed, view: new MutablePropertyView(parsed.properties ?? null, SAMPLE_MODEL) }, target);
  assert.deepEqual(current?.layers.map(layer => [layer.materialId, layer.thickness]), [[layers.layers[0].materialId, .2], [null, .1]]);
  assert.equal(parsed.entities.getGlobalId(target), globalId);
  assert.equal(parsed.entities.getName(target), WALL_NAME);
  assert.equal(result.receipt.applied[0].field, 'MaterialLayers');
  useViewerStore.getState().undo(SAMPLE_MODEL);
  const undo = await parseIfc(editedModelBytes(dataStore, view));
  assert.deepEqual(layerSetOf({ dataStore: undo, view: new MutablePropertyView(undo.properties ?? null, SAMPLE_MODEL) }, target)?.layers.map(layer => layer.thickness), [.25, .05]);
  useViewerStore.getState().redo(SAMPLE_MODEL);
  const redo = await parseIfc(editedModelBytes(dataStore, view));
  assert.deepEqual(layerSetOf({ dataStore: redo, view: new MutablePropertyView(redo.properties ?? null, SAMPLE_MODEL) }, target)?.layers.map(layer => layer.thickness), [.2, .1]);
});

test('#7275 native inspector preserves its unsupported source-wall section refusal and rolls back material creation', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const target = dataStore.entities.getExpressIdByGlobalId(BACK_WALL);
  const before = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(applyMaterialLayers(SAMPLE_MODEL, { kind: 'wall', target: 'element', elementId: target, typeId: null,
    layers: [{ thickness: .3, material: { name: 'Must not survive native refusal' } }] }), null);
  assert.equal(view.getNewEntities().length, 0, 'none of the staged material/layer/set/usage/relationship records survives refusal');
  const after = await parseIfc(editedModelBytes(dataStore, view));
  assert.deepEqual(after.getEntity(target)?.attributes, before.getEntity(target)?.attributes);
  assert.equal(layerSetOf({ dataStore: after, view: new MutablePropertyView(after.properties ?? null, SAMPLE_MODEL) }, target), null);
});

for (const attached of [false, true]) {
  test(`#7275 ${attached ? 'explicit attached' : 'rich selection'} actual request supplies a source-owned native layer expectation`, async () => {
    const { dataStore, view, target } = await inspectorControl();
    useViewerStore.getState().addEntityToSelection({ modelId: SAMPLE_MODEL, expressId: target });
    useViewerStore.getState().setSelectedEntityIds([target]);
    const selection = attached ? captureSelectionGrounding(useViewerStore.getState()) : null;
    replaceEvidence(captureEvidence(attached ? 'loadReport' : 'selection'));
    let body = '';
    globalThis.fetch = async (_url, init) => {
      body = String(init?.body);
      return new Response('data: {"choices":[{"delta":{"content":"Review"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    };
    assert.equal(await sendAssistant('Review current native layers', 'openai/gpt-free', '/api/chat',
      selection ? attachmentsForSend({ selection, screenshot: null }) : undefined), true);
    const wire: { system: string | Array<{ text: string }>; messages: Array<{ role: string; content: string }> } = JSON.parse(body);
    type NativeRow = { globalId: string; modelId: string; name: string | null; type: string; nativeLayers: NativeLayerEvidence };
    let row: NativeRow;
    let evidence: NativeLayerEvidence;
    if (attached) {
      const text = [...wire.messages].reverse().find(message => message.role === 'user')?.content;
      assert.ok(text);
      const elements: NativeRow[] = JSON.parse(text.split('\n').at(-1)!);
      row = elements[0];
      evidence = row.nativeLayers;
    } else {
      const system = typeof wire.system === 'string' ? wire.system : wire.system.map(block => block.text).join('');
      const frozen = system.split('Frozen native evidence:\n')[1]?.split('\n')[0];
      assert.ok(frozen);
      const captured: { evidence: { rows: Array<{ data: NativeRow }> } } = JSON.parse(frozen);
      row = captured.evidence.rows[0].data;
      evidence = row.nativeLayers;
    }
    assert.ok(evidence, 'the actual provider request must carry native layer evidence before its availability can be certified');
    assert.equal(evidence.status, 'available');
    assert.equal(evidence.units, 'm');
    assert.equal(evidence.layerCount, 2);
    assert.deepEqual(evidence.expected?.MaterialLayers.map(layer => [layer.LayerThickness, layer.Material?.Name]),
      [[.25, 'Explicit masonry'], [.05, 'Explicit finish']], 'actual provider JSON carries independently exported native values');
    assert.equal(evidence.expected?.wall?.kind, 'wall');
    const proposed = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Transported native layers',
      units: 'm', frame: 'storey-local', operations: [{ op: 'material.layers', scope: 'element',
        target: { globalId: row.globalId, modelId: row.modelId, ifcClass: row.type, name: row.name ?? '' },
        expected: evidence.expected, MaterialLayers: [{ LayerThickness: .15, Material: { create: { Name: 'Explicit provider material' } } },
          { LayerThickness: .2, Material: null }] }] }));
    const preview = previewModelAuthoring(useViewerStore.getState(), proposed);
    assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
    assert.ok(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test').ok);
    const parsed = await parseIfc(editedModelBytes(dataStore, view));
    const exported = layerSetOf({ dataStore: parsed, view: new MutablePropertyView(parsed.properties ?? null, SAMPLE_MODEL) }, target);
    assert.deepEqual(exported?.layers.map(layer => [layer.materialId === null ? null : parsed.getEntity(layer.materialId)?.attributes[0], layer.thickness]),
      [['Explicit provider material', .15], [null, .2]], 'proposal built from the actual transported expectation commits through the native writer');
  });
}


test('#7275 canonical layer snapshot follows named current thickness proven by native STEP', async () => {
  const { dataStore, view, target, layers } = await inspectorControl();
  const set = view.getNewEntity(layers.layerSetId);
  assert.ok(set && Array.isArray(set.attributes[0]));
  const first = Number(String(set.attributes[0][0]).replace(/^#/, ''));
  assert.ok(first > 0);
  view.setAttribute(first, 'LayerThickness', '200');
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const exported = layerSetOf({ dataStore: parsed, view: new MutablePropertyView(parsed.properties ?? null, SAMPLE_MODEL) }, target);
  assert.equal(exported?.layers[0].thickness, .2, 'actual named native edit exports as 200 mm');
  const state = useViewerStore.getState();
  const evidence = transportedLayerEvidence(state, target);
  assert.equal(evidence.expected?.MaterialLayers[0].LayerThickness, .2, 'provider expectation must match the same effective native record');
});


test('#7275 complete native layer counts survive the detail bound and capture stays read-only', async () => {
  const { view, target } = await inspectorControl();
  assert.ok(applyMaterialLayers(SAMPLE_MODEL, { kind: 'wall', target: 'element', elementId: target, typeId: null,
    layers: Array.from({ length: 33 }, () => ({ thickness: .01, material: null })) }) !== null);
  const lease = view.prepareAtomic(() => undefined);
  const state = useViewerStore.getState();
  const evidence = transportedLayerEvidence(state, target);
  assert.equal(evidence.status, 'truncated');
  assert.equal(evidence.layerCount, 33);
  assert.equal(evidence.assignmentCount, 1);
  assert.equal(evidence.expected, null, 'an incomplete expected population must never authorize a write');
  captureSelectionGrounding(state);
  assert.doesNotThrow(lease.validate, 'no live journal, allocator watermark or identity is changed by evidence reads');
});

test('#7275 unknown source-free unit provenance does not invent an available layer expectation', async () => {
  const { dataStore, target } = await inspectorControl();
  const state = useViewerStore.getState();
  const model = state.models.get(SAMPLE_MODEL)!;
  const unavailable = { ...state, models: new Map([[SAMPLE_MODEL, { ...model,
    ifcDataStore: { ...dataStore, source: EMPTY_SOURCE_BYTES, lengthUnitScale: undefined } }]]) };
  const evidence = transportedLayerEvidence(unavailable, target);
  assert.equal(evidence.status, 'unavailable');
  assert.equal(evidence.layerCount, null);
  assert.equal(evidence.assignmentCount, null);
  assert.equal(evidence.expected, null);
});


test('#7275 native type-layer expectation remains explicit beneath an occurrence override', async () => {
  const { dataStore, view, target } = await inspectorControl();
  const typeId = dataStore.entities.getExpressIdByGlobalId(FRONT_WALL_TYPE);
  recordModellingEdit(useViewerStore, SAMPLE_MODEL, methods => methods.assignType(SAMPLE_MODEL, typeId, [target]));
  assert.ok(applyMaterialLayers(SAMPLE_MODEL, { kind: 'wall', target: 'type', elementId: target, typeId,
    layers: [{ thickness: .4, material: { name: 'Type material beneath override' } }] }) !== null);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const native = layerSetOf({ dataStore: parsed, view: new MutablePropertyView(parsed.properties ?? null, SAMPLE_MODEL) }, typeId);
  assert.equal(native?.layers[0].thickness, .4, 'independent export proves the separate native type material population');
  const state = useViewerStore.getState();
  const evidence = transportedLayerEvidence(state, target);
  assert.equal(evidence.expected?.MaterialLayers[0].LayerThickness, .25, 'occurrence override remains authoritative for occurrence scope');
  const full: unknown = evidence.expected;
  assert.ok(full && typeof full === 'object' && 'typeLayers' in full);
  assert.deepEqual(full.typeLayers, { assignments: [{ expressId: native!.layerSetId, ifcClass: 'IfcMaterialLayerSet' }],
    layerSetId: native!.layerSetId, MaterialLayers: [{ LayerThickness: .4,
      Material: { modelId: SAMPLE_MODEL, expressId: native!.layers[0].materialId, Name: 'Type material beneath override' } }] });
});


function layerBatch(expected: NativeLayerExpected, globalId: string, scope: 'element' | 'type', units: 'm' | 'mm' = 'm') {
  const factor = units === 'mm' ? 1000 : 1;
  const convert = (layers: NativeLayerExpected['MaterialLayers']) => layers.map(layer => ({ ...layer, LayerThickness: layer.LayerThickness * factor }));
  return parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Explicit native scope', units, frame: 'storey-local',
    operations: [{ op: 'material.layers', target: { globalId, modelId: SAMPLE_MODEL, ifcClass: 'IfcWall', name: WALL_NAME }, scope,
      expected: { ...expected, MaterialLayers: convert(expected.MaterialLayers),
        typeLayers: expected.typeLayers ? { ...expected.typeLayers, MaterialLayers: convert(expected.typeLayers.MaterialLayers) } : null,
        wall: expected.wall && expected.wall.kind === 'wall' ? { kind: 'wall', height: expected.wall.height * factor, thickness: expected.wall.thickness * factor } : null },
      MaterialLayers: [{ LayerThickness: .7 * factor, Material: { create: { Name: 'Explicit type layers' } } }] }] }));
}

for (const units of ['m', 'mm'] as const) {
  test(`#7275 reviewed native type layers in ${units} preserve occurrence overrides, peer representations and root identities`, async () => {
    const { dataStore, view, target, globalId } = await inspectorControl();
    const typeId = dataStore.entities.getExpressIdByGlobalId(FRONT_WALL_TYPE);
    recordModellingEdit(useViewerStore, SAMPLE_MODEL, methods => methods.assignType(SAMPLE_MODEL, typeId, [target]));
    assert.ok(applyMaterialLayers(SAMPLE_MODEL, { kind: 'wall', target: 'type', elementId: target, typeId,
      layers: [{ thickness: .4, material: { name: 'Previous explicit type layers' } }] }) !== null);
    const state = useViewerStore.getState(), expected = transportedLayerEvidence(state, target).expected;
    assert.ok(expected?.peers && expected.typeLayers);
    assert.ok(expected.peers.length >= 2, 'real native type has both source and authored peers');
    const before = await parseIfc(editedModelBytes(dataStore, view));
    const peerIds = expected.peers.map(peer => before.entities.getExpressIdByGlobalId(peer.globalId));
    const lease = view.prepareAtomic(() => undefined);
    const preview = previewModelAuthoring(state, layerBatch(expected, globalId, 'type', units));
    assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
    assert.equal(preview.rows[0].previewUnavailable, true);
    assert.doesNotThrow(lease.validate, 'type-layer preflight never changes the live draft identity or allocator');
    const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
    assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
    const after = await parseIfc(editedModelBytes(dataStore, view)), afterView = new MutablePropertyView(after.properties ?? null, SAMPLE_MODEL);
    assert.deepEqual(layerSetOf({ dataStore: after, view: afterView }, target)?.layers.map(layer => layer.thickness), [.25, .05], 'own occurrence usage survives type scope');
    const native = layerSetOf({ dataStore: after, view: afterView }, typeId);
    assert.equal(native?.layers[0].thickness, .7);
    assert.equal(after.entities.getName(native!.layers[0].materialId!), 'Explicit type layers', 'canonical non-root source Name survives independent export/reparse');
    for (const id of peerIds) assert.deepEqual(after.getEntity(id)?.attributes, before.getEntity(id)?.attributes, 'native type assignment never rewrites occurrence roots or their representations');
    assert.equal(after.entities.getGlobalId(typeId), FRONT_WALL_TYPE);
    useViewerStore.getState().undo(SAMPLE_MODEL);
    const undone = await parseIfc(editedModelBytes(dataStore, view));
    assert.equal(layerSetOf({ dataStore: undone, view: new MutablePropertyView(undone.properties ?? null, SAMPLE_MODEL) }, typeId)?.layers[0].thickness, .4);
    useViewerStore.getState().redo(SAMPLE_MODEL);
    const redone = await parseIfc(editedModelBytes(dataStore, view));
    assert.equal(layerSetOf({ dataStore: redone, view: new MutablePropertyView(redone.properties ?? null, SAMPLE_MODEL) }, typeId)?.layers[0].thickness, .7);
  });
}

test('#7275 native material rename conflicts with old expected fields and skip-history edits invalidate an approved source', async () => {
  const { dataStore, view, target, globalId, layers } = await inspectorControl();
  const expected = transportedLayerEvidence(useViewerStore.getState(), target).expected;
  assert.ok(expected);
  const batch = layerBatch(expected, globalId, 'element');
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
  const mutationVersion = useViewerStore.getState().mutationVersion;
  view.setAttribute(layers.layers[0].materialId!, 'Name', 'Changed native material');
  assert.equal(useViewerStore.getState().mutationVersion, mutationVersion, 'actual direct native edit bypasses the viewer mutation counter');
  const before = editedModelBytes(dataStore, view);
  assert.deepEqual(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test'), { ok: false, reason: 'stale' });
  assert.equal(previewModelAuthoring(useViewerStore.getState(), batch).rows[0].status, 'conflict', 'new preflight rejects stale transported material names');
  await assertSameNativeIfcGraph(editedModelBytes(dataStore, view), before, 'both refusals preserve the current native model');
});

test('#7275 a source replacement with matching root fields still invalidates old layer approval', async () => {
  const { dataStore, view, target, globalId } = await inspectorControl();
  const state = useViewerStore.getState(), expected = transportedLayerEvidence(state, target).expected;
  assert.ok(expected);
  const preview = previewModelAuthoring(state, layerBatch(expected, globalId, 'element'));
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
  const replacement = await parseIfc(editedModelBytes(dataStore, view));
  const models = new Map(state.models), model = models.get(SAMPLE_MODEL)!;
  models.set(SAMPLE_MODEL, { ...model, ifcDataStore: replacement });
  useViewerStore.setState({ models });
  assert.deepEqual(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test'), { ok: false, reason: 'stale' });
});


for (const ifcClass of ['IfcSlab', 'IfcRoof', 'IfcPlate'] as const) {
  test(`#7275 native ${ifcClass} AXIS3 layers retain body and source-owned imported material identity`, async () => {
    const { dataStore, view } = await seedAuthoringSample();
    const create = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native layered panel', units: 'm', frame: 'storey-local',
      operations: [{ op: 'element.create', ref: 'panel', ifcClass, storey: { globalId: GROUND_STOREY }, name: 'Native layered panel',
        params: { position: [10, 10, 0], width: 4, depth: 3, thickness: .2 } }] }));
    const made = commitModelAuthoring(useViewerStore, previewModelAuthoring(useViewerStore.getState(), create), new Set([0]), 'test');
    assert.ok(made.ok, made.ok ? '' : made.detail ?? made.reason);
    const globalId = made.receipt.applied[0].globalId, before = await parseIfc(editedModelBytes(dataStore, view));
    const target = before.entities.getExpressIdByGlobalId(globalId);
    assert.equal(dataStore.entities.getName(62), 'concrete_reinforced_in-situ', 'real SketchUp IfcMaterial uses canonical non-root Name, not a GlobalId');
    const expected = transportedLayerEvidence(useViewerStore.getState(), target).expected;
    assert.ok(expected);
    const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native panel layers', units: 'mm', frame: 'storey-local',
      operations: [{ op: 'material.layers', scope: 'element', target: { globalId, modelId: SAMPLE_MODEL, ifcClass, name: 'Native layered panel' }, expected,
        MaterialLayers: [{ LayerThickness: 350, Material: { modelId: SAMPLE_MODEL, expressId: 62, Name: 'concrete_reinforced_in-situ' } }] }] }));
    const preview = previewModelAuthoring(useViewerStore.getState(), batch);
    assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
    assert.equal(preview.rows[0].previewUnavailable, true, 'native panel layer assignment has no changed-body geometry prediction');
    assert.ok(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test').ok);
    const after = await parseIfc(editedModelBytes(dataStore, view));
    const layers = layerSetOf({ dataStore: after, view: new MutablePropertyView(after.properties ?? null, SAMPLE_MODEL) }, target);
    assert.deepEqual(layers?.layers, [{ materialId: 62, thickness: .35 }]);
    assert.deepEqual(after.getEntity(target)?.attributes, before.getEntity(target)?.attributes, 'the native layer assignment preserves the occurrence representation and dimensions');
    assert.equal(after.entities.getName(62), 'concrete_reinforced_in-situ');
  });
}

test('#7275 native federation refuses ambiguous roots and foreign material owners, then edits only the pinned source', async () => {
  const { dataStore, view, target, globalId } = await inspectorControl();
  const exported = await parseIfc(editedModelBytes(dataStore, view)), model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  useViewerStore.getState().addModel({ ...model, id: 'other', name: 'Native source with the same roots', idOffset: 2_000_000, ifcDataStore: exported });
  const other = new MutablePropertyView(exported.properties ?? null, 'other');
  useViewerStore.getState().registerMutationView('other', other);
  const expected = transportedLayerEvidence(useViewerStore.getState(), target).expected;
  assert.ok(expected);
  const batch = layerBatch(expected, globalId, 'element');
  const unpinned = parseModelAuthoringBatch(JSON.stringify({ ...batch, operations: batch.operations.map(op => ({ ...op,
    target: { globalId, ifcClass: 'IfcWall', name: WALL_NAME } })) }));
  assert.equal(previewModelAuthoring(useViewerStore.getState(), unpinned).rows[0].status, 'ambiguous-target');
  const foreign = parseModelAuthoringBatch(JSON.stringify({ ...batch, operations: batch.operations.map(op => ({ ...op,
    MaterialLayers: [{ LayerThickness: .5, Material: { modelId: 'other', expressId: 62, Name: 'concrete_reinforced_in-situ' } }] })) }));
  assert.equal(previewModelAuthoring(useViewerStore.getState(), foreign).rows[0].status, 'conflict');
  const otherBefore = editedModelBytes(exported, other), preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
  assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  assert.equal(result.receipt.applied[0].modelId, SAMPLE_MODEL);
  const after = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(layerSetOf({ dataStore: after, view: new MutablePropertyView(after.properties ?? null, SAMPLE_MODEL) }, target)?.layers[0].thickness, .7);
  await assertSameNativeIfcGraph(editedModelBytes(exported, other), otherBefore, 'the independently owned federated source and overlay remain unchanged');
});

test('#7275 strict native layer contract refuses aliases, invented material GlobalIds, incomplete populations and STEP-token names', async () => {
  const { target, globalId } = await inspectorControl(), expected = transportedLayerEvidence(useViewerStore.getState(), target).expected;
  assert.ok(expected);
  const batch = layerBatch(expected, globalId, 'element');
  const op = batch.operations[0];
  const bad = [
    { ...op, thickness: .3 },
    { ...op, MaterialLayers: [{ Thickness: .3, Material: null }] },
    { ...op, MaterialLayers: [{ LayerThickness: .3, Material: { globalId: '0AAAAAAAAAAAAAAAAAAAAA', Name: 'Invented material GUID' } }] },
    { ...op, expected: { ...expected, assignments: undefined } },
    { ...op, MaterialLayers: Array.from({ length: 33 }, () => ({ LayerThickness: .01, Material: null })) },
    ...['$', '*', '#62'].map(Name => ({ ...op, MaterialLayers: [{ LayerThickness: .3, Material: { create: { Name } } }] })),
    { ...op, MaterialLayers: [{ LayerThickness: 0, Material: null }] },
    { ...op, MaterialLayers: [{ LayerThickness: -1, Material: null }] },
  ];
  for (const operation of bad) assert.throws(() => parseModelAuthoringBatch(JSON.stringify({ ...batch, operations: [operation] })));
  const untyped = parseModelAuthoringBatch(JSON.stringify({ ...batch, operations: [{ ...op, scope: 'type' }] }));
  assert.equal(previewModelAuthoring(useViewerStore.getState(), untyped).rows[0].status, 'unsupported', 'native type scope cannot infer or create an absent type');
  useViewerStore.setState({ editEnabled: false });
  assert.equal(previewModelAuthoring(useViewerStore.getState(), batch).rows[0].status, 'denied');
});


test('#7275 reviewed layers retain native unreadable hosted-cut refusal without leaking staged material records', async () => {
  const { dataStore, view, target, globalId } = await inspectorControl();
  const opened = useViewerStore.getState().addHostedFill(SAMPLE_MODEL, target,
    { kind: 'door', params: { Name: 'Native hosted-cut prerequisite', Offset: 1.5, Sill: 0, Width: 1, Height: 2 } });
  assert.ok('openingId' in opened);
  const position = getAttributeNamesForSchema('IfcOpeningElement', dataStore.schemaVersion).indexOf('Representation');
  assert.ok(position >= 0);
  view.setPositionalAttribute(opened.openingId, position, null);
  const exported = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(exported.getEntity(opened.openingId)?.attributes[position], null, 'real native edit/export makes the related hosted cut unreadable');
  const expected = transportedLayerEvidence(useViewerStore.getState(), target).expected;
  assert.ok(expected);
  const lease = view.prepareAtomic(() => undefined), count = view.getNewEntities().length;
  const preview = previewModelAuthoring(useViewerStore.getState(), layerBatch(expected, globalId, 'element'));
  assert.equal(preview.rows[0].status, 'invalid');
  assert.match(preview.rows[0].issue ?? '', /opening.*can.t be read/i);
  assert.doesNotThrow(lease.validate, 'native hosted-cut refusal publishes no layer construction or body writes');
  assert.equal(view.getNewEntities().length, count);
  assert.deepEqual(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test'), { ok: false, reason: 'nothing-approved' });
});


test('#7275 native occurrence plain material masks inherited type layers in both canonical snapshot and evidence', async () => {
  const { dataStore, view, target } = await inspectorControl();
  const typeId = dataStore.entities.getExpressIdByGlobalId(FRONT_WALL_TYPE);
  recordModellingEdit(useViewerStore, SAMPLE_MODEL, methods => methods.assignType(SAMPLE_MODEL, typeId, [target]));
  assert.ok(applyMaterialLayers(SAMPLE_MODEL, { kind: 'wall', target: 'type', elementId: target, typeId,
    layers: [{ thickness: .4, material: { name: 'Hidden type material' } }] }) !== null);
  recordModellingEdit(useViewerStore, SAMPLE_MODEL, methods => methods.assignMaterial(SAMPLE_MODEL, 62, [target]));
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const parsedView = new MutablePropertyView(parsed.properties ?? null, SAMPLE_MODEL);
  assert.equal(extractMaterialsOnDemand(parsed, target, parsedView)?.type, 'Material', 'independent native export proves the occurrence plain material overrides type layers');
  assert.equal(layerSetOf({ dataStore: parsed, view: parsedView }, typeId)?.layers[0].thickness, .4);
  assert.equal(layerSetOf({ dataStore: parsed, view: parsedView }, target), null, 'canonical inspector must not invent inherited layers behind a plain occurrence override');
  const evidence = transportedLayerEvidence(useViewerStore.getState(), target);
  assert.equal(evidence.layerCount, 0);
  assert.deepEqual(evidence.expected?.MaterialLayers, []);
  assert.equal(evidence.expected?.typeLayers?.MaterialLayers[0].LayerThickness, .4);
});


for (const scope of ['element', 'type'] as const) {
  test(`#7275 native ${scope} layer scope refuses same-model duplicate rooted identity`, async () => {
    const { dataStore, view, target, globalId } = await inspectorControl();
    const typeId = dataStore.entities.getExpressIdByGlobalId(FRONT_WALL_TYPE);
    if (scope === 'type') {
      recordModellingEdit(useViewerStore, SAMPLE_MODEL, methods => methods.assignType(SAMPLE_MODEL, typeId, [target]));
      assert.ok(applyMaterialLayers(SAMPLE_MODEL, { kind: 'wall', target: 'type', elementId: target, typeId,
        layers: [{ thickness: .4, material: { name: 'Actual type layers' } }] }) !== null);
    }
    const state = useViewerStore.getState();
    const expected = transportedLayerEvidence(state, target).expected;
    assert.ok(expected);
    const batch = layerBatch(expected, globalId, scope);
    const editor = state.storeEditors.get(SAMPLE_MODEL);
    assert.ok(editor);
    const owner = scope === 'element' ? target : typeId;
    const original = view.getNewEntity(owner) ?? dataStore.getEntity(owner);
    assert.ok(original);
    const attributes = [...original.attributes];
    const duplicate = editor.addEntity(scope === 'element' ? 'IfcWall' : 'IfcWallType', attributes);
    const source = await parseIfc(editedModelBytes(dataStore, view));
    assert.equal(source.entities.getGlobalId(duplicate.expressId), source.entities.getGlobalId(owner));
    assert.notEqual(duplicate.expressId, owner);
    assert.equal(source.entities.getName(duplicate.expressId), source.entities.getName(owner), 'same native Name cannot disambiguate identical RootGUIDs');
    const count = view.getMutationCount(), lease = view.prepareAtomic(() => undefined);
    const preview = previewModelAuthoring(useViewerStore.getState(), batch);
    assert.notEqual(preview.rows[0].status, 'ready', 'a public native duplicate root cannot be chosen silently for layer effects');
    assert.equal(view.getMutationCount(), count);
    assert.doesNotThrow(lease.validate);
  });
}


test('#7275 native intermediate layer effects cannot reuse an earlier expected layer population', async () => {
  const { dataStore, view, target, globalId } = await inspectorControl();
  const expected = transportedLayerEvidence(useViewerStore.getState(), target).expected;
  assert.ok(expected);
  const first = layerBatch(expected, globalId, 'element');
  const batch = parseModelAuthoringBatch(JSON.stringify({ ...first, operations: [first.operations[0], first.operations[0]] }));
  const before = view.getMutationCount(), lease = view.prepareAtomic(() => undefined);
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready');
  assert.notEqual(preview.rows[1].status, 'ready', 'second native write must compare its full expectation against the post-first-row draft');
  assert.equal(view.getMutationCount(), before);
  assert.doesNotThrow(lease.validate);
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0, 1]), 'test');
  assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  assert.equal(result.receipt.applied.length, 1);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(layerSetOf({ dataStore: parsed, view: new MutablePropertyView(parsed.properties ?? null, SAMPLE_MODEL) }, target)?.layers[0].thickness, .7);
});


test('#7275 a non-root material Name matching the target RootGUID remains a valid explicit material', async () => {
  const { dataStore, view, target, globalId } = await inspectorControl();
  recordModellingEdit(useViewerStore, SAMPLE_MODEL, methods => methods.addMaterial(SAMPLE_MODEL, { Name: globalId }));
  const expected = transportedLayerEvidence(useViewerStore.getState(), target).expected;
  assert.ok(expected);
  const batch = layerBatch(expected, globalId, 'element');
  const op = batch.operations[0];
  assert.equal(op.op, 'material.layers');
  assert.ok(op.op === 'material.layers');
  op.MaterialLayers[0].Material = { create: { Name: globalId } };
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? '');
  assert.ok(commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test').ok);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const current = layerSetOf({ dataStore: parsed, view: new MutablePropertyView(parsed.properties ?? null, SAMPLE_MODEL) }, target);
  assert.ok(current?.layers[0].materialId);
  assert.equal(parsed.entities.getName(current.layers[0].materialId), globalId);
  assert.equal(parsed.entities.getGlobalId(current.layers[0].materialId), '');
  assert.equal(parsed.entities.getGlobalId(target), globalId);
});


test('#7275 multiple distinct native layer definitions retain assignment count and refuse a guessed single population', async () => {
  const { dataStore, view, target } = await inspectorControl();
  const other = recordModellingEdit(useViewerStore, SAMPLE_MODEL, methods => methods.addMaterialLayerSet(SAMPLE_MODEL,
    { MaterialLayers: [{ LayerThickness: .4, Material: 62 }] }));
  const relation = view.getNewEntities().find(entity => entity.type.toUpperCase() === 'IFCRELASSOCIATESMATERIAL'
    && Array.isArray(entity.attributes[4]) && entity.attributes[4].includes(`#${target}`));
  assert.ok(relation);
  const editor = useViewerStore.getState().storeEditors.get(SAMPLE_MODEL);
  assert.ok(editor);
  const attributes = [...relation.attributes];
  attributes[0] = generateIfcGuid();
  attributes[5] = `#${other.expressId}`;
  editor.addEntity('IfcRelAssociatesMaterial', attributes);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const materials = extractAllMaterialsOnDemand(parsed, target);
  assert.equal(materials.length, 2, 'independent exported native graph retains both occurrence definitions');
  const evidence = transportedLayerEvidence(useViewerStore.getState(), target);
  assert.equal(evidence.assignmentCount, 2);
  assert.equal(evidence.status, 'unavailable', 'one layerSetId cannot honestly represent two different native sets');
  assert.equal(evidence.layerCount, null);
  assert.equal(evidence.expected, null);
});

for (const invalid of ['deleted', 'wrong-type', 'assignment-type', 'thickness-unset', 'material-value'] as const) test(`#7275 current native ${invalid} layer reference cannot become authoritative layer evidence`, async () => {
  const { dataStore, view, target } = await inspectorControl();
  const valid = transportedLayerEvidence(useViewerStore.getState(), target); assert.equal(valid.status, 'available'); assert.ok(valid.expected?.layerSetId);
  const saved = await parseIfc(editedModelBytes(dataStore, view)); const layerIds = effectiveMetadataRecord(saved, valid.expected.layerSetId)?.attributes[0]; assert.ok(Array.isArray(layerIds)); assert.equal(layerIds.length, 2);
  const editor = useViewerStore.getState().storeEditors.get(SAMPLE_MODEL); assert.ok(editor);
  let invalidId = Number(layerIds[0]);
  if (invalid === 'deleted') assert.equal(editor.removeEntity(invalidId), true);
  else if (invalid === 'thickness-unset') editor.setPositionalAttribute(invalidId, 1, null);
  else if (invalid === 'material-value') editor.setPositionalAttribute(invalidId, 0, 'not a native material reference');
  else { invalidId = saved.entityIndex.byType.get('IFCBUILDING')![0]; const building = effectiveMetadataRecord(saved, invalidId); assert.equal(building?.type, 'IfcBuilding'); assert.equal(typeof building?.attributes[1], 'number'); if (invalid === 'assignment-type') { const association = [...saved.entityIndex.byType.get('IFCRELASSOCIATESMATERIAL') ?? []].find(id => (effectiveMetadataRecord(saved, id)?.attributes[4] as number[] | undefined)?.includes(target)); assert.ok(association); editor.setPositionalAttribute(association, 5, `#${invalidId}`); } else editor.setPositionalAttribute(valid.expected.layerSetId, 0, [`#${invalidId}`]); }
  const reparsed = await parseIfc(editedModelBytes(dataStore, view)); const exportedRefs = effectiveMetadataRecord(reparsed, valid.expected.layerSetId)?.attributes[0]; assert.ok(Array.isArray(exportedRefs)); assert.equal(exportedRefs.includes(invalidId), ['wrong-type', 'thickness-unset', 'material-value'].includes(invalid), 'native export prunes deleted references and preserves wrong-type references');
  if (invalid === 'assignment-type') assert.ok([...reparsed.entityIndex.byType.get('IFCRELASSOCIATESMATERIAL') ?? []].some(id => { const relation = effectiveMetadataRecord(reparsed, id); return relation?.attributes[5] === invalidId && (relation.attributes[4] as number[]).includes(target); }), 'actual STEP relationship retains wrong native MaterialSelect target');
  assert.equal(effectiveMetadataRecord(reparsed, invalidId)?.type ?? null, invalid === 'deleted' ? null : ['thickness-unset', 'material-value'].includes(invalid) ? 'IfcMaterialLayer' : 'IfcBuilding', 'actual STEP retains a missing or wrong EXPRESS target, not a material layer');
  if (invalid === 'thickness-unset') assert.equal(effectiveMetadataRecord(reparsed, invalidId)?.attributes[1], null);
  if (invalid === 'material-value') assert.equal(effectiveMetadataRecord(reparsed, invalidId)?.attributes[0], 'not a native material reference');
  const evidence = transportedLayerEvidence(useViewerStore.getState(), target); assert.equal(evidence.status, 'unavailable'); assert.equal(evidence.expected, null, 'unknown current layer records must not be published as a complete available population');
});

// #7275: an unset target has no assigned native definition; raw relation rows are not definition counts.
test('#7275 native unset association target follows exported canonical empty-definition semantics', async () => {
  const { dataStore, view, target } = await inspectorControl();
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  const association = [...saved.entityIndex.byType.get('IFCRELASSOCIATESMATERIAL') ?? []].find(id => {
    const related = effectiveMetadataRecord(saved, id)?.attributes[4];
    return Array.isArray(related) && related.includes(target);
  });
  assert.ok(association);
  const editor = useViewerStore.getState().storeEditors.get(SAMPLE_MODEL); assert.ok(editor);
  editor.setPositionalAttribute(association, 5, null);
  const reparsed = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(effectiveMetadataRecord(reparsed, association)?.attributes[5], null, 'independent STEP retains the actual unset MaterialSelect slot');
  const related = effectiveMetadataRecord(reparsed, association)?.attributes[4];
  assert.ok(Array.isArray(related) && related.includes(target), 'native association ownership survives independently');
  const evidence = transportedLayerEvidence(useViewerStore.getState(), target);
  assert.equal(readRelatedLists(reparsed, 'IfcRelAssociatesMaterial').filter(row => row.relatedIds.includes(target)).length, 0,
    'the native query excludes unset MaterialSelect targets from valid assignments');
  assert.equal(readRelatedLists(reparsed, 'IfcRelAssociatesMaterial', undefined, { includeMalformedRelatingTargets: true })
    .filter(row => row.relatedIds.includes(target)).length, 0, 'strict inventory also preserves explicit unset semantics');
  assert.equal(evidence.assignmentCount, 0);
  assert.equal(evidence.layerCount, 0);
  assert.equal(evidence.status, 'available');
  assert.deepEqual(evidence.expected?.MaterialLayers, []);
});

// #7332: the canonical reader and authoring evidence must reject the same
// wrong EXPRESS target without rejecting an optional, genuinely absent Material.
test('#7275 native layer Material cannot reference a building in canonical reads', async () => {
  const { dataStore, view, target } = await inspectorControl();
  const before = layerSetOf({ dataStore, view }, target); assert.ok(before);
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  const refs = effectiveMetadataRecord(saved, before.layerSetId)?.attributes[0];
  assert.ok(Array.isArray(refs));
  const layerId = Number(refs[0]);
  const buildingId = saved.entityIndex.byType.get('IFCBUILDING')?.[0];
  assert.ok(buildingId);
  const editor = useViewerStore.getState().storeEditors.get(SAMPLE_MODEL); assert.ok(editor);
  editor.setPositionalAttribute(layerId, 0, `#${buildingId}`);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(effectiveMetadataRecord(parsed, layerId)?.attributes[0], buildingId);
  assert.equal(effectiveMetadataRecord(parsed, buildingId)?.type, 'IfcBuilding');
  assert.equal(transportedLayerEvidence(useViewerStore.getState(), target).status, 'unavailable');
  assert.equal(layerSetOf({ dataStore, view }, target), null,
    'canonical live read cannot expose a live IfcBuilding as an IfcMaterial');
  assert.equal(layerSetOf({ dataStore: parsed, view: new MutablePropertyView(parsed.properties ?? null, SAMPLE_MODEL) }, target), null,
    'independently reparsed native graph has the same refusal');
  editor.setPositionalAttribute(layerId, 0, null);
  const absent = layerSetOf({ dataStore, view }, target); assert.ok(absent);
  assert.equal(absent.layers[0].materialId, null, 'optional absent Material remains a supported native layer');
  assert.equal(transportedLayerEvidence(useViewerStore.getState(), target).status, 'available');
});

// #7332: invalid non-reference scalars are unknown, unlike an explicit IFC unset.
test('#7332 malformed native RelatingMaterial scalar revokes complete layer evidence', async () => {
  const { dataStore, view, target } = await inspectorControl();
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  const association = [...saved.entityIndex.byType.get('IFCRELASSOCIATESMATERIAL') ?? []].find(id => {
    const related = effectiveMetadataRecord(saved, id)?.attributes[4];
    return Array.isArray(related) && related.includes(target);
  });
  assert.ok(association);
  const editor = useViewerStore.getState().storeEditors.get(SAMPLE_MODEL); assert.ok(editor);
  editor.setPositionalAttribute(association, 5, 'not a MaterialSelect reference');
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  const relation = effectiveMetadataRecord(parsed, association); assert.ok(relation);
  assert.equal(relation.attributes[5], 'not a MaterialSelect reference');
  assert.ok(Array.isArray(relation.attributes[4]) && relation.attributes[4].includes(target));
  const ordinary = readRelatedLists(parsed, 'IfcRelAssociatesMaterial').filter(row => row.relatedIds.includes(target));
  assert.equal(ordinary.length, 0, 'default valid-assignment reader retains its existing behavior');
  const strict = readRelatedLists(parsed, 'IfcRelAssociatesMaterial', undefined, { includeMalformedRelatingTargets: true })
    .filter(row => row.relatedIds.includes(target));
  assert.equal(strict.length, 1, 'canonical strict inventory retains the actual malformed owned relation');
  assert.equal(strict[0].relatingId, undefined);
  const evidence = transportedLayerEvidence(useViewerStore.getState(), target);
  assert.equal(evidence.status, 'unavailable');
  assert.equal(evidence.expected, null);
});

test('#7332 source-empty thickness-only native layer cannot invent an unset Material', async () => {
  const { dataStore } = await seedAuthoringSample();
  const overlay = new MutablePropertyView(dataStore.properties ?? null, SAMPLE_MODEL);
  const layer = overlay.createEntity('IfcMaterialLayer', []);
  const set = overlay.createEntity('IfcMaterialLayerSet', [[`#${layer.expressId}`], 'Incomplete native layer']);
  overlay.setPositionalAttribute(layer.expressId, 1, .25);
  const sourceEmpty = { ...dataStore, source: EMPTY_SOURCE_BYTES, lengthUnitScale: 1 };
  assert.equal(effectiveMetadataRecord(sourceEmpty, layer.expressId, overlay)?.attributes[0], undefined,
    'a thickness-only native positional edit does not supply Material');
  assert.equal(readLayerSet({ dataStore: sourceEmpty, view: overlay }, set.expressId), null);
  overlay.setPositionalAttribute(layer.expressId, 0, null);
  assert.deepEqual(readLayerSet({ dataStore: sourceEmpty, view: overlay }, set.expressId)?.map(row => row.materialId), [null],
    'explicit native unset remains readable');
});
