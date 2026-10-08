/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { applyMaterialLayers } from '@/components/viewer/model-inspector/inspector-edits';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { layerSetOf } from '@/lib/commands/modeling/authored-kinds';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { BACK_WALL, FRONT_WALL_TYPE, GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { readOnlyModelEditTarget } from './model-authoring-read-target';
import { readAuthoringSizeFromTarget } from './model-authoring-size';
import type { NativeLayerEvidence } from './native-layer-evidence';
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
  assert.equal(readAuthoringSizeFromTarget(readTarget, target, 'wall')?.thickness, .3,
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
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
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
      const text = wire.messages.findLast(message => message.role === 'user')?.content;
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
    assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
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
    ifcDataStore: { ...dataStore, source: new Uint8Array(0), lengthUnitScale: undefined } }]]) };
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
