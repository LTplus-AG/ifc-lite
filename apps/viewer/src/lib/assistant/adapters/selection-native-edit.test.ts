/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type ViewerState } from '@/store';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample, parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { readAuthoringSize } from '@/lib/actions/model-authoring-size';
import { readElementProfile } from '@/store/slices/mutation-element-profile';
import { captureEvidence } from '../evidence';
import { cancelAssistant, replaceEvidence, useAssistant } from '../conversation';
import { sendAssistant } from '../request';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { setElementDimensions, setElementProfileSection } from '@/components/viewer/model-inspector/inspector-edits';
import { readOnlyModelEditTarget } from '@/lib/actions/model-authoring-read-target';
import { nativeEditEvidence } from '@/lib/actions/native-edit-evidence';

const initial = useViewerStore.getState();
const initialAssistant = useAssistant.getState();
const originalFetch = globalThis.fetch;
afterEach(() => { cancelAssistant(); globalThis.fetch = originalFetch; useAssistant.setState(initialAssistant, true); useViewerStore.setState(initial, true); });
const s = useViewerStore.getState;
const idOf = (outcome: { expressId: number } | { error: string }): number => {
  assert.ok('expressId' in outcome, 'error' in outcome ? outcome.error : '');
  return outcome.expressId;
};
const profile = { Type: 'RectangleHollow' as const, XDim: .25, YDim: .4, WallThickness: .015, InnerFilletRadius: 0, OuterFilletRadius: .005 };

async function targets() {
  const { dataStore } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const wall = idOf(s().addWall(SAMPLE_MODEL, storey, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: .2, Height: 3, Name: 'Native editable wall' }));
  const beam = idOf(s().addBeam(SAMPLE_MODEL, storey, { Start: [0, 0, 4], End: [4, 0, 4], Profile: profile, Name: 'Native editable hollow beam' }));
  const model = s().models.get(SAMPLE_MODEL)!;
  const exported = await parseIfc(editedModelBytes(model.ifcDataStore!, s().mutationViews.get(SAMPLE_MODEL) ?? null));
  const readback: ViewerState = { ...s(), models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: exported }]]),
    mutationViews: new Map([[SAMPLE_MODEL, new MutablePropertyView(exported.properties, SAMPLE_MODEL)]]), storeEditors: new Map() };
  assert.deepEqual(readAuthoringSize(readback, SAMPLE_MODEL, wall, 'wall'), { kind: 'wall', height: 3, thickness: .2 });
  assert.deepEqual(readElementProfile(readback, SAMPLE_MODEL, beam), profile, 'independent STEP reparse proves exact section, including zero and optional radius');
  s().addEntityToSelection({ modelId: SAMPLE_MODEL, expressId: wall });
  s().addEntityToSelection({ modelId: SAMPLE_MODEL, expressId: beam });
  return { wall, beam, exported };
}

function capturedRows() {
  return JSON.parse(captureEvidence('selection').payload).evidence.rows.map((row: { data: Record<string, unknown> }) => row.data);
}

test('#7264 freshly authored wall and hollow beam expose complete native editable snapshots without authored Qto', async () => {
  const { wall, beam } = await targets();
  const rows = capturedRows();
  const wallRow = rows.find((row: Record<string, unknown>) => row.expressId === wall);
  const beamRow = rows.find((row: Record<string, unknown>) => row.expressId === beam);
  assert.ok(wallRow && beamRow, 'existing source-owned identities remain available');
  assert.equal(wallRow.qsetCount, 0);
  assert.equal(beamRow.qsetCount, 0);
  assert.equal(wallRow.name, 'Native editable wall');
  assert.equal(beamRow.name, 'Native editable hollow beam');
  assert.deepEqual(wallRow.nativeEdit, { units: 'm', dimensionsStatus: 'available',
    dimensions: { kind: 'wall', height: 3, thickness: .2 }, profileStatus: 'unavailable', Profile: null });
  assert.deepEqual(beamRow.nativeEdit, { units: 'm', dimensionsStatus: 'available',
    dimensions: { kind: 'linear', length: 4, width: .25, cross: .4, profiled: true }, profileStatus: 'available', Profile: profile });
});

test('#7264 explicit Attach selection carries source-owned overlay identities and complete native snapshots', async () => {
  const { wall, beam } = await targets();
  s().setSelectedEntityIds([wall, beam]); // Native single-model fallback: renderer ID equals express ID.
  const selection = captureSelectionGrounding(s());
  assert.equal(selection.elements.length, 2);
  assert.equal(selection.elements[0].name, 'Native editable wall');
  assert.deepEqual(selection.elements[1].nativeEdit.Profile, profile);
  replaceEvidence(captureEvidence('loadReport'));
  let messages: unknown;
  globalThis.fetch = async (_url, init) => {
    messages = JSON.parse(String(init?.body)).messages;
    return new Response('data: {"choices":[{"delta":{"content":"Review"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  assert.equal(await sendAssistant('Resize the attached wall', 'openai/gpt-free', '/api/chat', attachmentsForSend({ selection, screenshot: null })), true);
  assert.match(JSON.stringify(messages), /RectangleHollow/);
  assert.match(JSON.stringify(messages), /nativeEdit/);
});

test('#7264 first native read keeps source views/editor maps, history and capture identity untouched', async () => {
  const { wall, exported } = await targets();
  const model = s().models.get(SAMPLE_MODEL)!;
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: exported }]]),
    mutationViews: new Map(), storeEditors: new Map() });
  const before = s();
  const target = readOnlyModelEditTarget(before, SAMPLE_MODEL);
  assert.deepEqual(nativeEditEvidence(target, wall).dimensions, { kind: 'wall', height: 3, thickness: .2 });
  assert.equal(s(), before, 'no viewer publication at first source read');
  assert.equal(before.mutationViews.size, 0);
  assert.equal(before.storeEditors.size, 0);
  assert.equal(s().undoStacks, before.undoStacks);
  assert.equal(s().dirtyModels, before.dirtyModels);
  assert.equal(s().models, before.models);
});

test('#7264 live edits refresh native snapshots without publishing detached read watermark/history', async () => {
  const { wall, beam } = await targets();
  const live = s().mutationViews.get(SAMPLE_MODEL)!;
  const lease = live.prepareAtomic(() => null);
  const before = s();
  capturedRows();
  captureSelectionGrounding(s());
  assert.doesNotThrow(() => lease.validate(), 'native overlay including allocator watermark remains identical');
  assert.equal(s(), before);
  assert.equal(setElementDimensions(SAMPLE_MODEL, wall, { kind: 'wall', height: 4, thickness: .3 }), true);
  assert.equal(setElementProfileSection(SAMPLE_MODEL, beam, { Type: 'CircleHollow', Radius: .2, WallThickness: .01 }), true);
  const rows = capturedRows();
  assert.deepEqual(rows.find((row: Record<string, unknown>) => row.expressId === wall)?.nativeEdit.dimensions,
    { kind: 'wall', height: 4, thickness: .3 });
  assert.deepEqual(rows.find((row: Record<string, unknown>) => row.expressId === beam)?.nativeEdit.Profile,
    { Type: 'CircleHollow', Radius: .2, WallThickness: .01 });
});

test('#7264 an attached native geometry snapshot cannot be sent after a native edit and evidence refresh', async () => {
  const { wall } = await targets();
  s().setSelectedEntityIds([wall]);
  const selection = captureSelectionGrounding(s());
  assert.equal(setElementDimensions(SAMPLE_MODEL, wall, { kind: 'wall', height: 5 }), true);
  replaceEvidence(captureEvidence('loadReport')); // Fresh source evidence must not certify the OLD explicit attachment.
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response('data: {"choices":[{"delta":{"content":"Old snapshot"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  assert.equal(await sendAssistant('Use the attached dimensions', 'openai/gpt-free', '/api/chat', attachmentsForSend({ selection, screenshot: null })), false);
  assert.equal(requests, 0);
});

test('#7264 the actual Assistant request carries native expected geometry from selected evidence', async () => {
  await targets();
  replaceEvidence(captureEvidence('selection'));
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response('data: {"choices":[{"delta":{"content":"Review the supplied geometry"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  assert.equal(await sendAssistant('Prepare an editable section change', 'openai/gpt-free', '/api/chat'), true);
  const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system)
    ? body.system.map((block: { text?: string }) => block.text ?? '').join('\n') : '';
  assert.match(system, /"nativeEdit":\{"units":"m"/);
  assert.match(system, /"Type":"RectangleHollow"/);
  assert.equal(body.tools, undefined, 'snapshots do not add executable provider tools');
});

test('#7264 unrelated existing selection attributes remain available', async () => {
  await seedAuthoringSample();
  s().setSelectedEntity({ modelId: SAMPLE_MODEL, expressId: 262 });
  const row = capturedRows().find((value: Record<string, unknown>) => value.expressId === 262);
  assert.equal(row?.name, 'house - outer wall - house right front');
  assert.equal(row?.type, 'IfcWall');
  assert.match(String(row?.globalId), /^.{22}$/);
});
