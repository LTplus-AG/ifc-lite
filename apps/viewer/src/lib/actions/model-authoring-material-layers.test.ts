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
import { layerSetOf } from '@/lib/commands/modeling/authored-kinds';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { BACK_WALL, GROUND_STOREY, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';
import { readOnlyModelEditTarget } from './model-authoring-read-target';
import { readAuthoringSizeFromTarget } from './model-authoring-size';
import { nativeLayerEvidence, type NativeLayerEvidence } from './native-layer-evidence';
import { captureSelectionGrounding } from './selection-grounding';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { captureEvidence } from '@/lib/assistant/evidence';
import { cancelAssistant, replaceEvidence, useAssistant } from '@/lib/assistant/conversation';
import { sendAssistant } from '@/lib/assistant/request';

const original = useViewerStore.getState();
const originalAssistant = useAssistant.getState(), originalFetch = globalThis.fetch;
const WALL_NAME = 'Native layer wall';
afterEach(() => { cancelAssistant(); globalThis.fetch = originalFetch; useAssistant.setState(originalAssistant, true); useViewerStore.setState(original, true); });

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
  const { layers, globalId } = await inspectorControl();
  assert.doesNotThrow(() => parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Explicit native layers',
    units: 'm', frame: 'storey-local', operations: [{ op: 'material.layers',
      target: { globalId, modelId: SAMPLE_MODEL, ifcClass: 'IfcWall', name: WALL_NAME }, scope: 'element',
      expected: { layerSetId: layers.layerSetId, via: layers.via, MaterialLayers: layers.layers.map(layer => ({
        LayerThickness: layer.thickness, Material: { modelId: SAMPLE_MODEL, expressId: layer.materialId, Name: layer.materialId === layers.layers[0].materialId ? 'Explicit masonry' : 'Explicit finish' },
      })) },
      MaterialLayers: [{ LayerThickness: .2, Material: { modelId: SAMPLE_MODEL, expressId: layers.layers[0].materialId, Name: 'Explicit masonry' } },
        { LayerThickness: .1, Material: null }],
    }] })), '#7275 native inspector layer assignment must be admitted through explicit reviewed authoring');
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
    const { target } = await inspectorControl();
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
    let evidence: NativeLayerEvidence;
    if (attached) {
      const text = wire.messages.findLast(message => message.role === 'user')?.content;
      assert.ok(text);
      const elements: Array<{ nativeLayers: NativeLayerEvidence }> = JSON.parse(text.split('\n').at(-1)!);
      evidence = elements[0].nativeLayers;
    } else {
      const system = typeof wire.system === 'string' ? wire.system : wire.system.map(block => block.text).join('');
      const frozen = system.split('Frozen native evidence:\n')[1]?.split('\n')[0];
      assert.ok(frozen);
      const captured: { evidence: { rows: Array<{ data: { nativeLayers: NativeLayerEvidence } }> } } = JSON.parse(frozen);
      evidence = captured.evidence.rows[0].data.nativeLayers;
    }
    assert.equal(evidence.status, 'available');
    assert.equal(evidence.units, 'm');
    assert.equal(evidence.layerCount, 2);
    assert.deepEqual(evidence.expected?.MaterialLayers.map(layer => [layer.LayerThickness, layer.Material?.Name]),
      [[.25, 'Explicit masonry'], [.05, 'Explicit finish']], 'actual provider JSON carries independently exported native values');
    assert.equal(evidence.expected?.wall?.kind, 'wall');
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
  const evidence = nativeLayerEvidence(state, readOnlyModelEditTarget(state, SAMPLE_MODEL), target);
  assert.equal(evidence.expected?.MaterialLayers[0].LayerThickness, .2, 'provider expectation must match the same effective native record');
});


test('#7275 complete native layer counts survive the detail bound and capture stays read-only', async () => {
  const { view, target } = await inspectorControl();
  assert.ok(applyMaterialLayers(SAMPLE_MODEL, { kind: 'wall', target: 'element', elementId: target, typeId: null,
    layers: Array.from({ length: 33 }, () => ({ thickness: .01, material: null })) }) !== null);
  const lease = view.prepareAtomic(() => undefined);
  const state = useViewerStore.getState();
  const evidence = nativeLayerEvidence(state, readOnlyModelEditTarget(state, SAMPLE_MODEL), target);
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
  const evidence = nativeLayerEvidence(unavailable, readOnlyModelEditTarget(unavailable, SAMPLE_MODEL), target);
  assert.equal(evidence.status, 'unavailable');
  assert.equal(evidence.layerCount, null);
  assert.equal(evidence.assignmentCount, null);
  assert.equal(evidence.expected, null);
});
