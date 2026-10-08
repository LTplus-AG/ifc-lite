/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { SAMPLE_MODEL, seedAuthoringSample, parseIfc } from '@/test/authoring-sample-fixture';
import { captureEvidence } from '../evidence';
import { cancelAssistant, replaceEvidence, useAssistant } from '../conversation';
import { sendAssistant } from '../request';
import { captureSelectionGrounding } from '@/lib/actions/selection-grounding';
import { attachmentsForSend } from '@/components/viewer/assistant/ComposerAttachments';
import { setElementDimensions, setElementProfileSection } from '@/components/viewer/model-inspector/inspector-edits';
import { readOnlyModelEditTarget } from '@/lib/actions/model-authoring-read-target';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { nativeEditEvidence } from '@/lib/actions/native-edit-evidence';
import { federationRegistry } from '@ifc-lite/renderer';
import { contiguousSourceBytes, EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';

const initial = useViewerStore.getState();
const initialAssistant = useAssistant.getState();
const originalFetch = globalThis.fetch;
afterEach(() => { cancelAssistant(); globalThis.fetch = originalFetch; useAssistant.setState(initialAssistant, true); useViewerStore.setState(initial, true); });
const s = useViewerStore.getState;
import { nativeEditTargets as targets, nativeProfile as profile } from '@/test/native-edit-evidence-fixture';

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

test('#7264 declared metre and millimetre models publish the same SI snapshots regardless of display override', async () => {
  for (const metres of [false, true]) {
    const { wall, beam } = await targets(metres);
    useViewerStore.setState({ unitDisplayOverrides: { LENGTHUNIT: 'mm' } });
    const rows = capturedRows();
    assert.deepEqual(rows.find((row: Record<string, unknown>) => row.expressId === wall)?.nativeEdit.dimensions,
      { kind: 'wall', height: 3, thickness: .2 });
    assert.deepEqual(rows.find((row: Record<string, unknown>) => row.expressId === beam)?.nativeEdit.Profile, profile);
  }
});

test('#7264 identical native IDs in two sources stay model-owned through both evidence routes', async () => {
  const { wall, exported } = await targets();
  const other = 'native-edit-other';
  federationRegistry.unregisterModel(SAMPLE_MODEL);
  const aOffset = federationRegistry.registerModel(SAMPLE_MODEL, 100_000);
  const bOffset = federationRegistry.registerModel(other, 100_000);
  try {
    const sourceB = await parseIfc(editedModelBytes(exported, null));
    const model = s().models.get(SAMPLE_MODEL)!;
    useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, idOffset: aOffset }],
      [other, { ...model, id: other, idOffset: bOffset, maxExpressId: Math.max(...sourceB.entityIndex.byId.keys()), ifcDataStore: sourceB }]]) });
    assert.equal(setElementDimensions(other, wall, { kind: 'wall', height: 6 }), true);
    s().addEntityToSelection({ modelId: other, expressId: wall });
    const rows = capturedRows();
    assert.equal(rows.find((row: Record<string, unknown>) => row.modelId === SAMPLE_MODEL && row.expressId === wall)?.nativeEdit.dimensions.height, 3);
    assert.equal(rows.find((row: Record<string, unknown>) => row.modelId === other && row.expressId === wall)?.nativeEdit.dimensions.height, 6);
    s().setSelectedEntityIds([federationRegistry.toGlobalId(SAMPLE_MODEL, wall)!, federationRegistry.toGlobalId(other, wall)!]);
    const attachment = captureSelectionGrounding(s());
    assert.deepEqual(attachment.elements.map(element => [element.modelId, element.nativeEdit.dimensions]), [
      [SAMPLE_MODEL, { kind: 'wall', height: 3, thickness: .2 }], [other, { kind: 'wall', height: 6, thickness: .2 }],
    ]);
  } finally { federationRegistry.unregisterModel(SAMPLE_MODEL); federationRegistry.unregisterModel(other); }
});

test('#7264 unsupported geometry and unavailable model input remain unknown', async () => {
  await seedAuthoringSample();
  const target = readOnlyModelEditTarget(s(), SAMPLE_MODEL);
  assert.ok(target);
  assert.deepEqual(nativeEditEvidence(target, 1).dimensions, null);
  assert.deepEqual(nativeEditEvidence(target, 1).Profile, null);
  assert.deepEqual(nativeEditEvidence(readOnlyModelEditTarget(s(), 'absent'), 262), {
    units: 'm', dimensionsStatus: 'unavailable', dimensions: null, profileStatus: 'unavailable', Profile: null,
  });
});

test('#7264 attachment work and detail bounds count unresolved IDs without expanding beyond 100 reads', async () => {
  await seedAuthoringSample();
  const state = s();
  let lookups = 0;
  const capture = captureSelectionGrounding({ ...state, selectedEntityIds: new Set(Array.from({ length: 500 }, (_, index) => 1_000_000 + index)),
    resolveGlobalIdFromModels: () => { lookups++; return null; } }, 10_000);
  assert.equal(lookups, 100);
  assert.equal(capture.total, 500);
  assert.equal(capture.unresolved, 100);
  assert.equal(capture.truncated, true);
  assert.equal(capture.elements.length, 0);
  s().setSelectedEntity({ modelId: SAMPLE_MODEL, expressId: 262 });
  assert.ok(captureEvidence('selection', 1).includedRows <= 1);
});

test('#7264 source-free geometry without a recorded length unit cannot certify SI values', async () => {
  const { wall } = await targets();
  const model = s().models.get(SAMPLE_MODEL)!;
  const original = model.ifcDataStore!;
  const unknown = { ...original, source: EMPTY_SOURCE_BYTES, lengthUnitScale: undefined };
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: unknown }]]) });
  const target = readOnlyModelEditTarget(s(), SAMPLE_MODEL);
  assert.ok(target);
  assert.equal(nativeEditEvidence(target, wall).dimensionsStatus, 'unavailable');
  assert.equal(nativeEditEvidence(target, wall).dimensions, null);
});

test('#7264 recorded source-free length units remain authoritative for authored geometry', async () => {
  const { wall } = await targets();
  const model = s().models.get(SAMPLE_MODEL)!;
  const original = model.ifcDataStore!;
  assert.equal(original.lengthUnitScale, .001);
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: { ...original, source: EMPTY_SOURCE_BYTES } }]]) });
  const target = readOnlyModelEditTarget(s(), SAMPLE_MODEL);
  assert.ok(target);
  assert.deepEqual(nativeEditEvidence(target, wall).dimensions, { kind: 'wall', height: 3, thickness: .2 });
});

test('#7264 unreadable retained length-unit declarations report unavailable instead of breaking evidence capture', async () => {
  const { wall } = await targets();
  const model = s().models.get(SAMPLE_MODEL)!;
  const original = model.ifcDataStore!;
  const text = new TextDecoder().decode(original.source.materialize());
  assert.match(text, /\.METRE\./);
  const source = contiguousSourceBytes(new TextEncoder().encode(text.replaceAll('.METRE.', '.BOGUS.')));
  useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, ifcDataStore: { ...original, source, lengthUnitScale: undefined } }]]) });
  const target = readOnlyModelEditTarget(s(), SAMPLE_MODEL);
  assert.ok(target);
  assert.equal(nativeEditEvidence(target, wall).dimensionsStatus, 'unavailable');
});
