/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { render, click, cleanup, waitFor, type as input } from '@/test/render';
import { captureFetch } from '@/test/fetch-stub';
import { seedSemanticModels } from '@/test/semantic-model-fixture';
import { useSemanticSession } from '@/lib/semantic/session';
import { DEMO_REVISIONS, pilotDocument } from '@/lib/semantic/demo';
import { useSemanticSourceTexts } from '@/lib/semantic/assist/source-texts';
import { revokeEndpointGrant, useSemanticEndpointGrant } from '@/lib/semantic/assist/endpoint-grant';
import { captureRevisionPin } from '@/lib/semantic/assist/revision-pin';
import { saveSemanticReview, semanticReviewLibrary, useSemanticReviews } from '@/lib/semantic/assist/library';
import { parseSemanticMapping } from '@/lib/semantic/assist/mapping-proposal';
import { executeValidation } from '@/lib/semantic/validation-job';
import { SemanticPanel } from './SemanticPanel';
import { SemanticAssistControls } from './SemanticAssistControls';

const original = useViewerStore.getState();
const session = useSemanticSession.getState();
afterEach(() => {
  cleanup(); revokeEndpointGrant(); useSemanticSourceTexts.setState({ sources: [] });
  useViewerStore.setState(original, true); useSemanticSession.setState(session, true);
});
const find = (ui: HTMLElement, selector: string, text: string) => {
  const element = [...ui.querySelectorAll<HTMLElement>(selector)].find(candidate => candidate.textContent?.startsWith(text));
  assert.ok(element, text); return element;
};

test('#6920 attached texts are session-only, numbered S1..S9 and removable; saved reviews show whether their revision context is still current', async () => {
  await seedSemanticModels(2);
  const errors: string[] = [];
  const ui = render(<SemanticAssistControls onError={message => errors.push(message)} />);
  input(ui.querySelector('textarea')!, 'Doors shall be EI30.');
  click(find(ui, 'button', 'Attach text'));
  assert.deepEqual(useSemanticSourceTexts.getState().sources.map(source => [source.id, source.title]), [['S1', 'Pasted specification']]);
  click(find(ui, 'button', 'Attach current records'));
  assert.deepEqual(useSemanticSourceTexts.getState().sources.map(source => source.id), ['S1', 'S2']);
  click(ui.querySelector('button[aria-label="Remove attached text S1"]')!);
  assert.deepEqual(useSemanticSourceTexts.getState().sources.map(source => source.id), ['S2']);
  assert.equal(localStorage.getItem('ifc-lite.semantic.workspace.v1'), null, 'attached texts are never persisted by the panel');

  const proposal = parseSemanticMapping(JSON.stringify({ version: 1, kind: 'semantic.mapping', title: 'Saved doors', modelRevision: DEMO_REVISIONS[0],
    mappings: [{ ifc: { class: 'IfcDoor' }, ontology: { class: 'Installation' }, confidence: 0.7 }] }));
  await act(async () => { await saveSemanticReview({ version: 1, id: 'review-1', type: 'mapping', createdAt: '2026-01-01T00:00:00.000Z', origin: 'test',
    profile: { id: 'p', version: '1' }, pin: captureRevisionPin(), proposal, approved: [0] }); });
  await waitFor(() => /Saved doors/.test(ui.textContent ?? ''), 'saved review listed');
  assert.match(ui.textContent ?? '', /1 mapping for .*revision\/1/);
  assert.match(ui.textContent ?? '', /Current/);
  act(() => useSemanticSession.setState({ revisions: new Map([[DEMO_REVISIONS[0], 'm1']]) }));
  assert.match(ui.textContent ?? '', /Historical/);
  assert.doesNotMatch(ui.textContent ?? '', /Current/);
  // The saved entry itself is not rewritten by becoming historical: it keeps the pin it was approved against.
  const kept = useSemanticReviews.getState().entries[0];
  assert.deepEqual(kept.type === 'mapping' && kept.pin.associations.map(item => item.modelId), ['m0', 'm1']);
  // A stored review whose proposal no longer passes the strict decoders is kept, counted and never listed as valid.
  await act(async () => { await semanticReviewLibrary.put('review-bad', { ...kept, id: 'review-bad', proposal: { kind: 'semantic.mapping', version: 1 } }); });
  await waitFor(() => /1 saved review could not be read/.test(ui.textContent ?? ''), 'unreadable review counted');
  assert.equal(useSemanticReviews.getState().entries.length, 2, 'the unreadable entry is preserved, not dropped');
  await act(async () => { await semanticReviewLibrary.put('review-bad', null); });
  click(ui.querySelector('button[aria-label="Delete saved review Saved doors"]')!);
  await waitFor(() => useSemanticReviews.getState().entries.length === 0, 'deleted');
  assert.equal(await semanticReviewLibrary.put('review-1', null), true);
  assert.deepEqual(errors, []);
});

function field(ui: HTMLElement, text: string) { const element = find(ui, 'label', text).querySelector('input'); assert.ok(element); return element; }

for (const change of ['endpoint', 'host', 'bearer', 'relay', 'mode', 'restore', 'unmount'] as const) {
  test(`#6920 the assistant keeps the endpoint authority only until ${change} changes it`, async () => {
    const stub = captureFetch(() => new Response(JSON.stringify(pilotDocument()), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const ui = render(<SemanticPanel validationExecutor={executeValidation} />);
      const select = find(ui, 'label', 'Data source').querySelector('select')!;
      act(() => { select.value = 'json'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
      input(field(ui, 'Endpoint URL'), 'https://graph.example.org/records');
      input(field(ui, 'Allow requests to hostname'), 'graph.example.org');
      find(ui, 'details', 'Authentication').setAttribute('open', '');
      input(find(ui, 'label', 'Bearer').querySelector('input')!, 'PANEL-SECRET');
      assert.equal(useSemanticEndpointGrant.getState().grant, null, 'typing is not exercising');
      click(find(ui, 'button', 'Load records'));
      await waitFor(() => stub.sent.length === 1, 'the request was made');
      const grant = useSemanticEndpointGrant.getState().grant;
      assert.deepEqual([grant?.endpoint, grant?.host, grant?.bearer], ['https://graph.example.org/records', 'graph.example.org', 'PANEL-SECRET']);
      if (change === 'endpoint') input(field(ui, 'Endpoint URL'), 'https://other.example.org/records');
      else if (change === 'host') input(field(ui, 'Allow requests to hostname'), 'other.example.org');
      else if (change === 'bearer') input(find(ui, 'label', 'Bearer').querySelector('input')!, 'ANOTHER');
      else if (change === 'relay') input(find(ui, 'label', 'Authorized relay').querySelector('input')!, 'relay-1');
      else if (change === 'mode') act(() => { select.value = 'sparql'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
      else if (change === 'restore') click(find(ui, 'button', 'Restore saved workspace'));
      else cleanup();
      assert.equal(useSemanticEndpointGrant.getState().grant, null);
    } finally { stub.restore(); }
  });
}


test('#7000 attaching current records excludes the retrieval endpoint from passage text', async () => {
  const { document } = await seedSemanticModels();
  const endpoint = 'https://private.example/signed?token=secret';
  useSemanticSession.setState({ document: { ...document, source: endpoint } });
  const ui = render(<SemanticAssistControls onError={message => { throw new Error(message); }} />);
  click(find(ui, 'button', 'Attach current records'));
  const source = useSemanticSourceTexts.getState().sources[0];
  assert.ok(source.text.includes('Installed door'));
  assert.ok(!source.text.includes(endpoint));
});

test('#7000 a refused blank endpoint load never grants assistant query authority', async () => {
  const ui = render(<SemanticPanel validationExecutor={executeValidation} />);
  const select = find(ui, 'label', 'Data source').querySelector('select')!;
  act(() => { select.value = 'json'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  click(find(ui, 'button', 'Load records'));
  assert.equal(useSemanticEndpointGrant.getState().grant, null);
});


test('#7000 changing a credential cancels pending retrieval before it can publish old records', async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const stub = captureFetch(() => pending);
  try {
    const ui = render(<SemanticPanel validationExecutor={executeValidation} />);
    const select = find(ui, 'label', 'Data source').querySelector('select')!;
    act(() => { select.value = 'json'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
    input(field(ui, 'Endpoint URL'), 'https://graph.example.org/records');
    input(field(ui, 'Allow requests to hostname'), 'graph.example.org');
    const before = useSemanticSession.getState().document;
    click(find(ui, 'button', 'Load records'));
    await waitFor(() => stub.sent.length === 1, 'retrieval began');
    input(find(ui, 'label', 'Bearer').querySelector('input')!, 'REPLACEMENT');
    await act(async () => { release(new Response(JSON.stringify(pilotDocument()), { headers: { 'content-type': 'application/json' } })); await pending; });
    assert.equal(useSemanticSession.getState().document, before, 'old-credential response never publishes');
    assert.equal(useSemanticEndpointGrant.getState().grant, null);
  } finally { stub.restore(); }
});
