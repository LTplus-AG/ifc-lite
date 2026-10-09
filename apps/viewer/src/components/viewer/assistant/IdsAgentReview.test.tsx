/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IDS agent in the Assistant (IDS-081, IDS-082, IDS-085, IDS-086), driven
 * end to end through the real panel, the real Anthropic SDK and the real
 * grounding gate, with the model replaced by scripted SSE streams (no key, no
 * network).
 */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { render, click, cleanup, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { anthropicStream, serveAnthropicStreams } from '@/test/anthropic-sse';
import { sampleIdsDraft } from '@/test/check-authoring-fixture';
import { captureEvidence } from '@/lib/assistant/evidence';
import { cancelAssistant, replaceEvidence, useAssistant } from '@/lib/assistant/conversation';
import { setAssistantDraft } from '@/lib/assistant/composer-draft';
import { resetIdsAgent, useIdsAgent } from '@/lib/ids-agent/run';
import { loadDefinitionLibrary } from '@/lib/validation/definition-library';
import { updateApiKeys } from '@/services/api-keys';
import { IdsDraftChecks } from '../check-authoring/IdsDraftChecks';
import { AssistantPanel } from './AssistantPanel';

const initial = useViewerStore.getState();
let restoreFetch: (() => void) | null = null;
afterEach(() => {
  cleanup(); cancelAssistant(); resetIdsAgent(); restoreFetch?.(); restoreFetch = null;
  useViewerStore.setState(initial, true); localStorage.clear(); setAssistantDraft('');
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

const eq = (value: string) => ({ kind: 'equals', value });
const spaceOps = (pset?: string) => [
  { kind: 'spec.add', payload: { specId: '@spaces', name: 'Spaces are named', ifcVersions: ['IFC4'] } },
  { kind: 'facet.add', payload: { specId: '@spaces', section: 'applicability', facetId: '@a', facet: { type: 'entity', name: eq('IfcSpace') } } },
  pset
    ? { kind: 'facet.add', payload: { specId: '@spaces', section: 'requirements', facetId: '@r', facet: { type: 'property', propertySet: eq(pset), baseName: eq('Reference') } } }
    : { kind: 'facet.add', payload: { specId: '@spaces', section: 'requirements', facetId: '@r', facet: { type: 'attribute', name: eq('Name') } } },
];
const button = (root: HTMLElement, name: RegExp) => {
  const found = [...root.querySelectorAll('button')].find(candidate => name.test(candidate.textContent ?? ''));
  assert.ok(found, `button ${name}`);
  return found;
};

async function openPanel(prompt: string, model = 'claude-opus-5-5') {
  await seedAuthoringSample({ editEnabled: false });
  replaceEvidence(captureEvidence('loadReport'));
  updateApiKeys({ anthropicKey: 'test-key-not-a-secret' });
  useViewerStore.setState({ chatActiveModel: model });
  setAssistantDraft(prompt);
  const ui = render(<AssistantPanel />);
  await waitFor(() => !!ui.querySelector('section[aria-label="Draft IDS with tools"]'), 'the IDS agent card mounts');
  return { ui, card: ui.querySelector<HTMLElement>('section[aria-label="Draft IDS with tools"]')! };
}

test('a drafted IDS is grounded, reviewed per change, shows what was sent, and saves through the native gates', async () => {
  const served = serveAnthropicStreams([
    anthropicStream([{ type: 'tool_use', id: 'toolu_1', name: 'ids_apply_ops', input: { ops: spaceOps('Pset_SpaceMagic') } }]),
    anthropicStream([{ type: 'tool_use', id: 'toolu_2', name: 'ids_apply_ops', input: { ops: spaceOps(),
      sources: [{ quote: 'Every space has a name.' }], rationale: 'Spaces need a name' } }]),
    anthropicStream([{ type: 'tool_use', id: 'toolu_3', name: 'ids_mark_unresolved', input: { statement: 'Spaces are at least 8 m2.', category: 'geometry', reason: 'Area is measured from geometry.' } }]),
    anthropicStream([{ type: 'text', text: 'One specification; one statement left unresolved.' }]),
  ]);
  restoreFetch = served.restore;
  const { card } = await openPanel('Every space has a name. Spaces are at least 8 m2.');
  click(button(card, /Draft IDS from the message/));
  await waitFor(() => useIdsAgent.getState().phase === 'done', 'the run finishes', 20_000);

  // The invented property set was refused by the gate and fed back to the model as an error.
  assert.equal(served.bodies.length, 4);
  const second = JSON.stringify((served.bodies[1].messages as unknown[]).at(-1));
  assert.match(second, /"is_error":true/);
  assert.match(second, /GATE-PSET-001/);
  assert.match(String(served.bodies[0].model), /claude-opus-5-5/);

  const text = card.textContent ?? '';
  assert.match(text, /One specification; one statement left unresolved\./);
  assert.match(text, /Spaces are named/);
  assert.match(text, /New specification/);
  assert.match(text, /Source: “Every space has a name\.”/);
  assert.match(text, /Spaces are at least 8 m2\. \(geometry: Area is measured from geometry\.\)/);
  assert.match(text, /1 of 1 changes kept/);
  assert.match(text, /What was sent/);
  assert.match(text, /No data from your loaded models was sent/);
  assert.doesNotMatch(text, /Pset_SpaceMagic.*New specification/);

  click(button(card, /Use the kept changes/));
  await waitFor(() => /Native IDS audit: 0 errors/.test(card.textContent ?? ''), 'the accepted draft passes the native audit', 20_000);
  assert.match(card.textContent ?? '', /Spaces are at least 8 m2\./, 'the unresolved statement travels with the draft');
  click(button(card, /Dry run on loaded models/));
  await waitFor(() => !button(card, /Save to IDS library/).disabled, 'the draft dry-runs', 20_000);
  click(button(card, /Save to IDS library/));
  const [entry] = loadDefinitionLibrary().library.entries;
  assert.ok(entry && entry.kind === 'ids');
  assert.deepEqual(entry.document.specifications.map(spec => spec.name), ['Spaces are named']);
  assert.match(entry.document.info.description ?? '', /Spaces are at least 8 m2/);
});

test('a dropped change is not used, and a clarification is asked with gated choices', async () => {
  const served = serveAnthropicStreams([
    anthropicStream([{ type: 'tool_use', id: 'toolu_q', name: 'ids_ask_user', input: { question: 'Which spaces?', choices: [
      { label: 'All spaces', ops: spaceOps() }, { label: 'None', ops: [] }] } }]),
    anthropicStream([{ type: 'text', text: 'Done.' }]),
  ]);
  restoreFetch = served.restore;
  const { card } = await openPanel('Spaces have names.');
  click(button(card, /Draft IDS from the message/));
  await waitFor(() => !!card.querySelector('section[aria-label="The agent needs a decision"]'), 'the question is shown', 20_000);
  assert.match(card.textContent ?? '', /Which spaces\?/);
  click(button(card, /All spaces/));
  await waitFor(() => useIdsAgent.getState().phase === 'done', 'the run finishes', 20_000);
  assert.match(card.textContent ?? '', /Which spaces\? → All spaces/);
  const keep = card.querySelector<HTMLInputElement>('input[aria-label^="Keep: "]')!;
  click(keep);
  assert.match(card.textContent ?? '', /0 of 1 changes kept/);
  assert.equal(button(card, /Use the kept changes/).disabled, true);
});

test('the hosted free models are refused with a reason instead of the old JSON path', async () => {
  const { card } = await openPanel('Spaces have names.', 'openai/gpt-free');
  click(button(card, /Draft IDS from the message/));
  await waitFor(() => /needs your own Anthropic or OpenAI key/.test(card.textContent ?? ''), 'the reason is shown');
  assert.equal(useIdsAgent.getState().run, null);
});

// #6915 review, kept: an audit that could not run is not a clean audit.
test('an IDS audit that fails to run blocks saving and export, and stays shown after a dry run', async () => {
  await seedAuthoringSample({ editEnabled: false });
  const root = render(<IdsDraftChecks draft={sampleIdsDraft()} audit={() => Promise.reject(new Error('schema data failed to load'))} />);
  await waitFor(() => /audit could not run/.test(root.textContent ?? ''), 'the audit failure is shown');
  assert.doesNotMatch(root.textContent ?? '', /0 errors/);
  assert.match(root.textContent ?? '', /schema data failed to load/);
  assert.equal(button(root, /Export \.ids/).disabled, true);
  click(button(root, /Dry run on loaded models/));
  await waitFor(() => !!root.querySelector('section[aria-label="Dry-run results"]'), 'the dry run completes', 20_000);
  assert.equal(button(root, /Save to IDS library/).disabled, true, 'a current dry run does not unblock an audit that never ran');
  assert.equal(button(root, /Export \.ids/).disabled, true);
});
