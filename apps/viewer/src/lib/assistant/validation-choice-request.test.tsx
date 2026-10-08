/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { act } from 'react';
import test, { afterEach, before } from 'node:test';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS, type ValidationReport } from '@ifc-lite/ids';
import { Rule } from '@ifc-lite/rules';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { runIdsCheck } from '@/lib/validation/run-ids-check';
import { runInformationCheck } from '@/lib/validation/run-information-check';
import { setValidationSourceChoice, useValidationSourceChoice, type ValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { captureEvidence, evidenceIsCurrent } from './evidence';
import { replaceEvidence, cancelAssistant, useAssistant } from './conversation';
import { sendAssistant } from './request';
import { ValidationPanel } from '@/components/viewer/validation/ValidationPanel';
import { render, mouseDown, cleanup } from '@/test/render';

const initial = useViewerStore.getState();
const originalFetch = globalThis.fetch;
const initialChoice = useValidationSourceChoice.getState().choice;
let ids: ValidationReport;
let rules: ValidationReport;
let nativeModels: ReturnType<typeof fixtureModels>;

before(async () => {
  const bytes = await readFile('public/samples/building-architecture.ifc');
  assert.match(bytes.subarray(0, 4000).toString(), /SketchUp/);
  const store = await new IfcParser().parseColumnar(Uint8Array.from(bytes).buffer, { disableWorkerScan: true });
  const walls = store.entityIndex.byType.get('IFCWALL') ?? [];
  assert.ok(walls.length > 0, 'a real authoring model must contain the evaluated population');
  nativeModels = fixtureModels({ ...fixtureModel('architecture'), sourceFingerprint: 'committed-sketchup', ifcDataStore: store });
  const reportModels = new Map([['architecture', { name: 'building-architecture.ifc', sourceFingerprint: 'committed-sketchup' }]]);
  const document = parseIDS(`<ids xmlns="http://standards.buildingsmart.org/IDS"><info><title>Native wall names</title></info>
    <specifications><specification name="Impossible wall name" ifcVersion="IFC4">
    <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
    <requirements><attribute cardinality="required"><name><simpleValue>Name</simpleValue></name>
    <value><simpleValue>IMPOSSIBLE_7098_NAME</simpleValue></value></attribute></requirements>
    </specification></specifications></ids>`);
  ids = (await runIdsCheck({ document, modelId: 'architecture', dataStore: store, locale: 'en', models: reportModels })).report;
  rules = (await runInformationCheck({ models: [{ id: 'architecture', store }], reportModels,
    ruleSet: { version: 1, name: 'Native wall name rules', rules: [{ id: 'wall-name', name: 'Impossible wall name',
      applicability: { groups: [{ combinator: 'AND', rules: [Rule.ifcType(['IfcWall'])] }], authoredAs: 'chips' },
      requirement: { kind: 'element', block: { groups: [{ combinator: 'AND', rules: [Rule.attribute('Name', 'eq', 'IMPOSSIBLE_7098_NAME')] }], authoredAs: 'chips' } },
    }] },
  })).report;
  assert.equal(ids.summary.totalEntitiesFailed, walls.length);
  assert.equal(rules.summary.totalEntitiesFailed, walls.length);
});

afterEach(() => {
  cleanup();
  cancelAssistant();
  globalThis.fetch = originalFetch;
  useViewerStore.setState(initial, true);
  setValidationSourceChoice(initialChoice);
});

function streamGate() {
  let opened: () => void = () => {};
  const ready = new Promise<void>(resolve => { opened = resolve; });
  let release: () => void = () => {};
  const response = new Promise<Response>(resolve => {
    release = () => resolve(new Response('data: {"choices":[{"delta":{"content":"Late answer [E1]"},"finish_reason":"stop"}]}\n\n'));
  });
  let signal: AbortSignal | null | undefined;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    signal = init?.signal;
    opened();
    return response;
  };
  return { ready, release, get signal() { return signal; }, get calls() { return calls; } };
}

for (const [from, to] of [['ids', 'rules'], ['ids', 'manual'], ['rules', 'ids'], ['rules', 'manual']] as const) {
  test(`native ${from} evidence cancels when the Data validation source switches to ${to} (#7098)`, async () => {
    useViewerStore.setState({ ...nativeModels, idsValidationReport: from === 'ids' ? ids : rules });
    setValidationSourceChoice(from);
    const snapshot = captureEvidence('validation');
    const report = useViewerStore.getState().idsValidationReport;
    assert.equal(JSON.parse(snapshot.payload).evidence.summary.source, from);
    replaceEvidence(snapshot);
    const gate = streamGate();
    const pending = sendAssistant('Explain these native failures', 'openai/gpt-free', '/api/chat');
    await gate.ready;
    setValidationSourceChoice(to);
    assert.equal(gate.signal?.aborted, true, 'source-store notification must cancel the owned request immediately');
    assert.equal(useAssistant.getState().error, 'stale-evidence');
    assert.equal(evidenceIsCurrent(snapshot), false);
    assert.equal(useViewerStore.getState().idsValidationReport, report, 'side selection preserves the native report');
    gate.release();
    assert.equal(await pending, false);
    assert.equal(useAssistant.getState().messages.length, 0, 'late provider success cannot commit a stale answer');
    assert.equal(await sendAssistant('Again', 'openai/gpt-free', '/api/chat'), false);
    assert.equal(gate.calls, 1, 'stale evidence refuses another transport request');
    replaceEvidence(captureEvidence('validation'));
    assert.equal(evidenceIsCurrent(useAssistant.getState().snapshot!), true, 'explicit refresh starts a fresh frozen subject');
  });
}

for (const choice of ['ids', 'rules'] as const) {
  test(`manual checklist request cancels when switching to ${choice} (#7098)`, async () => {
    useViewerStore.setState({ ...nativeModels, manualChecklist: { version: 1, name: 'Coordinator checks',
      groups: [{ id: 'review', name: 'Manual review', items: [{ id: 'wall-location', text: 'Review wall location' }] }] } });
    setValidationSourceChoice('manual');
    replaceEvidence(captureEvidence('manualChecklist'));
    const gate = streamGate();
    const pending = sendAssistant('Explain outstanding manual checks', 'openai/gpt-free', '/api/chat');
    await gate.ready;
    setValidationSourceChoice(choice);
    assert.equal(gate.signal?.aborted, true);
    gate.release();
    assert.equal(await pending, false);
    assert.equal(useAssistant.getState().error, 'stale-evidence');
    assert.equal(useAssistant.getState().messages.length, 0);
  });
}

test('changing Data validation sides preserves an unrelated native source request (#7098)', async () => {
  useViewerStore.setState(nativeModels);
  setValidationSourceChoice('ids');
  const snapshot = captureEvidence('loadReport');
  replaceEvidence(snapshot);
  const gate = streamGate();
  const pending = sendAssistant('Explain model load limitations', 'openai/gpt-free', '/api/chat');
  await gate.ready;
  for (const choice of ['rules', 'manual', 'ids'] satisfies ValidationSourceChoice[]) setValidationSourceChoice(choice);
  assert.equal(gate.signal?.aborted, false);
  assert.equal(evidenceIsCurrent(snapshot), true);
  gate.release();
  assert.equal(await pending, true);
  assert.equal(useAssistant.getState().messages.at(-1)?.content, 'Late answer [E1]');
});

test('choosing the already attached side preserves the active validation request (#7098)', async () => {
  useViewerStore.setState({ ...nativeModels, idsValidationReport: ids });
  setValidationSourceChoice('ids');
  replaceEvidence(captureEvidence('validation'));
  const gate = streamGate();
  const pending = sendAssistant('Explain native wall failures', 'openai/gpt-free', '/api/chat');
  await gate.ready;
  setValidationSourceChoice('ids');
  assert.equal(gate.signal?.aborted, false, 'same identity remains current despite a store notification');
  gate.release();
  assert.equal(await pending, true);
});

test('switching sides cancels a live native SSE reader and clears partial validation output (#7098)', async () => {
  useViewerStore.setState({ ...nativeModels, idsValidationReport: rules });
  setValidationSourceChoice('rules');
  replaceEvidence(captureEvidence('validation'));
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Partial native findings"}}]}\n\n'));
    },
    cancel() { cancelled = true; },
  }));
  const pending = sendAssistant('Explain native wall failures', 'openai/gpt-free', '/api/chat');
  for (let i = 0; i < 100 && !useAssistant.getState().output; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(useAssistant.getState().output, 'Partial native findings', 'the real response reader must have consumed a chunk');
  let ui: HTMLElement | undefined;
  await act(async () => {
    ui = render(<ValidationPanel />);
    await new Promise(resolve => setImmediate(resolve));
  });
  assert.ok(ui);
  const manualTab = [...ui.querySelectorAll<HTMLElement>('[role="tab"]')].find(tab => tab.textContent === 'Manual validation');
  assert.ok(manualTab, 'the native panel must expose its Manual validation tab');
  mouseDown(manualTab);
  assert.equal(useValidationSourceChoice.getState().choice, 'manual');
  assert.equal(useAssistant.getState().output, '', 'the revoked subject must not leave partial findings visible');
  assert.equal(await pending, false);
  assert.equal(cancelled, true, 'abort must reach the active response body');
  assert.equal(useAssistant.getState().error, 'stale-evidence');
  assert.equal(useAssistant.getState().messages.length, 0);
});
