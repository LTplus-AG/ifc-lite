/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The MCP playground is the second consumer of the BYOK Anthropic credential,
 * and it had no coverage: dropping the workspace id in `runConversation`, or
 * passing the wrong one to the error mapper, left the whole suite green while
 * reintroducing on this surface the exact bug the change exists to fix.
 *
 * Both assertions read what actually left the process — the outgoing headers,
 * and the message the panel renders — rather than the arguments handed inward.
 */

import '@/test/setup-dom.js';

import { act, useState } from 'react';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, waitFor, advance, type as typeInto } from '@/test/render.js';
import { captureFetch, jsonResponse } from '@/test/fetch-stub.js';
import { clearApiKeys, updateApiKeys } from '@/services/api-keys';
import { parsePlaygroundModel, type LoadedPlaygroundModel } from './playground-dispatcher.js';
import { PlaygroundChat } from './PlaygroundChat.js';

const WORKSPACE = 'wrkspc_01playground';

/** The composer refuses to send without a model, so give it a one-wall one. */
async function oneWallModel(): Promise<LoadedPlaygroundModel> {
  const step = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', "#1=IFCWALL('0aBcDeFgHiJkLmNoPqRsT3',$,'Wall A',$,$,$,$,$,.STANDARD.);",
    'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
  const bytes = new TextEncoder().encode(step);
  return parsePlaygroundModel(bytes.buffer as ArrayBuffer, 'probe.ifc');
}

/** Drive the composer the way a user does: type, then submit the form. */
async function send(container: HTMLElement, prompt: string): Promise<void> {
  const ta = container.ownerDocument.querySelector('textarea');
  assert.ok(ta, 'composer textarea must render');
  typeInto(ta, prompt);
  const { act } = await import('react');
  await act(async () => {
    ta.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe('MCP playground BYOK credential', () => {
  beforeEach(() => { clearApiKeys(); });
  afterEach(() => { cleanup(); clearApiKeys(); });

  it('sends anthropic-workspace-id with the playground request', async () => {
    updateApiKeys({ anthropicKey: 'sk-ant-api03-playground', anthropicWorkspaceId: WORKSPACE });
    const stub = captureFetch(() => jsonResponse({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    try {
      const container = render(<PlaygroundChat model={await oneWallModel()} />);
      await send(container, 'hello');
      const anthropic = stub.sent.filter((h) => h.has('x-api-key'));
      assert.ok(anthropic.length > 0, 'expected a request to Anthropic');
      assert.equal(anthropic[0].get('anthropic-workspace-id'), WORKSPACE);
    } finally {
      stub.restore();
    }
  });

  it('does not tell a user who has a workspace id to go add one', async () => {
    // The mapper takes the id the request carried. Handing it '' here produced
    // a dead end: "Add the workspace id" shown to someone who already had.
    updateApiKeys({ anthropicKey: 'sk-ant-api03-playground', anthropicWorkspaceId: WORKSPACE });
    const stub = captureFetch(() => jsonResponse({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'anthropic-workspace-id header must be a valid workspace ID.' },
    }, 400));
    try {
      const container = render(<PlaygroundChat model={await oneWallModel()} />);
      await send(container, 'hello');
      const shown = container.textContent ?? '';
      assert.match(shown, /rejected the Workspace ID/);
      assert.doesNotMatch(shown, /Add the workspace id/);
    } finally {
      stub.restore();
    }
  });
});

// #9577: each lifecycle boundary must retire only its own conversation.
for (const action of ['replace', 'stop', 'unmount'] as const) it(`playground ${action} aborts the current API turn`, async t => {
  t.after(() => { cleanup(); clearApiKeys(); });
  updateApiKeys({ anthropicKey: 'sk-ant-test' });
  const model = await oneWallModel();
  const signals: AbortSignal[] = [];
  const pending: Array<() => void> = [];
  t.after(() => { for (const finish of pending) finish(); });
  t.mock.method(globalThis, 'fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise<Response>((resolve, reject) => { pending.push(() => resolve(jsonResponse({ id: 'disposed', type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }))); init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))); });
  });
  let swap!: () => void;
  function Host() { const [current, setCurrent] = useState(model); swap = () => setCurrent({ ...model }); return <PlaygroundChat model={current} />; }
  const ui = render(<Host />); await send(ui, 'hello');
  assert.equal(signals.length > 0, true);
  if (action === 'replace') act(() => swap());
  else if (action === 'unmount') cleanup();
  else { const stop = ui.querySelector<HTMLButtonElement>('button[aria-label="Stop generating"]'); assert.equal(Boolean(stop), true); act(() => stop!.click()); }
  assert.equal(signals.every(signal => signal.aborted), true, 'retiring the run cancels the API turn');
  if (action === 'stop') assert.equal(ui.querySelectorAll('button[aria-label="Stop generating"]').length, 0, 'Stop restores the send control');
  await advance(0);
  assert.equal(ui.textContent?.toLowerCase().includes('aborted'), false, 'retired API failures do not populate the new context');
  cleanup(); clearApiKeys();
});

for (const phase of ['response', 'tool'] as const) it(`playground Stop during ${phase} prevents subsequent tool mutations`, async t => {
  t.after(() => { cleanup(); clearApiKeys(); });
  updateApiKeys({ anthropicKey: 'sk-ant-test' });
  const model = await oneWallModel();
  let release!: () => void, calls = 0, mutations = 0;
  const message = { id: 'msg_stop', type: 'message', role: 'assistant', model: 'claude-opus-5',
    content: [
      ...(phase === 'tool' ? [{ type: 'text', text: 'Already received before Stop.' }, { type: 'tool_use', id: 'viewer', name: 'viewer_open', input: {} }] : []),
      { type: 'tool_use', id: 'mutation', name: 'entity_set_property', input: { express_id: 1, pset: 'Pset_Test', name: 'AfterStop', value: 'forbidden' } },
    ], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls > 1) return jsonResponse({ ...message, content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' });
    if (phase === 'response') await new Promise<void>(resolve => { release = resolve; });
    return jsonResponse(message);
  });
  let ui!: HTMLElement;
  const stop = () => { const button = ui.querySelector<HTMLButtonElement>('button[aria-label="Stop generating"]'); assert.equal(Boolean(button), true); act(() => button!.click()); };
  ui = render(<PlaygroundChat model={model} dispatchContext={() => ({ onModelChanged: () => { mutations++; }, openViewerPanel: stop })} />);
  await send(ui, 'Change the property');
  if (phase === 'response') { stop(); await act(async () => release()); }
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(mutations, 0, 'stopping before or during tool processing prevents subsequent edits');
  assert.equal(calls, 1, 'the aborted conversation makes no further API turns');
  if (phase === 'tool') {
    assert.equal(ui.textContent?.includes('Already received before Stop.'), true, 'Stop preserves received text');
    assert.equal(ui.textContent?.includes('Stopped'), false, 'received text does not become a stopped placeholder');
  }
});

it('playground same-tick submissions start one API turn', async t => {
  t.after(() => { cleanup(); clearApiKeys(); });
  updateApiKeys({ anthropicKey: 'sk-ant-test' });
  const releases: Array<() => void> = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++; await new Promise<void>(resolve => releases.push(resolve));
    return jsonResponse({ id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const ui = render(<PlaygroundChat model={await oneWallModel()} />);
  const input = ui.querySelector('textarea')!; typeInto(input, 'hello');
  const submit = () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  act(() => { submit(); submit(); });
  await waitFor(() => calls > 0, 'API turn started');
  const count = calls;
  await act(async () => { for (const finish of releases) finish(); });
  assert.equal(count, 1);
  assert.equal([...ui.querySelectorAll('li')].filter(message => message.textContent === 'hello').length, 1, 'same-tick submissions create one transcript turn');
});

it('playground an old API completion cannot clear a replacement run or show its error', async t => {
  t.after(() => { cleanup(); clearApiKeys(); });
  updateApiKeys({ anthropicKey: 'sk-ant-test' });
  const replies: Array<(response: Response) => void> = [];
  t.after(() => { for (const finish of replies) finish(jsonResponse({ id: 'disposed', type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } })); });
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => replies.push(resolve)));
  const ui = render(<PlaygroundChat model={await oneWallModel()} />);
  await send(ui, 'first');
  act(() => ui.querySelector<HTMLButtonElement>('button[aria-label="Stop generating"]')!.click());
  await send(ui, 'replacement');
  assert.equal(replies.length, 2);
  await act(async () => replies[0](jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'retired request error' } }, 400)));
  await advance(0);
  const stillRunning = ui.querySelectorAll('button[aria-label="Stop generating"]').length;
  const staleError = ui.textContent?.includes('retired request error');
  await act(async () => replies[1](jsonResponse({ id: 'replacement', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'replacement complete' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })));
  assert.equal(stillRunning, 1, 'old finally cannot clear the replacement streaming flag');
  assert.equal(staleError, false);
});

// #9577 N2: a dropdown selection applies to the next turn, not the turn in flight.
it('#9577 changing the model dropdown preserves the current turn and its fixed modelId', async t => {
  const { getPlaygroundModel, setPlaygroundModel } = await import('@/services/playground-model');
  const { getByokModelsForSource } = await import('@/lib/llm/models');
  const prior = getPlaygroundModel();
  t.after(() => { cleanup(); clearApiKeys(); setPlaygroundModel(prior); });
  updateApiKeys({ anthropicKey: 'sk-ant-test' });
  const other = getByokModelsForSource('anthropic').find(candidate => candidate.id !== prior)!;
  const requested: string[] = [], signals: AbortSignal[] = [];
  let release!: () => void;
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    requested.push(JSON.parse(String(init?.body)).model);
    if (init?.signal) signals.push(init.signal);
    if (requested.length === 1) await new Promise<void>(resolve => { release = resolve; });
    return jsonResponse({ id: 'msg_choice', type: 'message', role: 'assistant',
      content: requested.length === 1
        ? [{ type: 'tool_use', id: 'info', name: 'model_info', input: {} }]
        : [{ type: 'text', text: 'The turn survived the dropdown change.' }],
      stop_reason: requested.length === 1 ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const ui = render(<PlaygroundChat model={await oneWallModel()} />);
  await send(ui, 'Inspect this model');
  const select = ui.querySelector('select')!;
  act(() => { select.value = other.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
  const aborted = signals.some(signal => signal.aborted);
  const running = ui.querySelectorAll('button[aria-label="Stop generating"]').length;
  await act(async () => release());
  await waitFor(() => ui.textContent?.includes('The turn survived the dropdown change.') === true || aborted, 'turn completed');
  assert.equal(aborted, false, 'choosing the next model leaves the current request alive');
  assert.equal(running, 1, 'the current turn retains its Stop control');
  assert.deepEqual([...requested], [prior, prior], 'every tool round uses the original model');
  await send(ui, 'Next turn');
  assert.equal(requested.at(-1), other.id, 'the next turn uses the dropdown selection');
});

for (const contract of ['stop glyph', 'localized stopped status'] as const) it(`#9577 stopping before text shows a ${contract}`, async t => {
  const { registerLocale, setLocale } = await import('@/i18n');
  const { mcpPlaygroundDe } = await import('@/i18n/locales/de/mcp-playground');
  const { mcpPlaygroundFr } = await import('@/i18n/locales/fr/mcp-playground');
  const { mcpPlaygroundIt } = await import('@/i18n/locales/it/mcp-playground');
  const { mcpPlaygroundRu } = await import('@/i18n/locales/ru/mcp-playground');
  t.after(() => { cleanup(); clearApiKeys(); setLocale('en'); });
  updateApiKeys({ anthropicKey: 'sk-ant-test' });
  let finish!: () => void;
  t.after(() => finish?.());
  t.mock.method(globalThis, 'fetch', (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    finish = () => resolve(jsonResponse({ id: 'disposed', type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }));
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const ui = render(<PlaygroundChat model={await oneWallModel()} />);
  await send(ui, 'Stop before answering');
  const stop = ui.querySelector<HTMLButtonElement>('button[aria-label="Stop generating"]')!;
  const glyph = Boolean(stop.querySelector('svg.lucide-square'));
  act(() => stop.click());
  await advance(0);
  if (contract === 'stop glyph') {
    assert.equal(glyph, true, 'Stop displays an action glyph instead of a progress spinner');
    return;
  }
  assert.equal(ui.textContent?.includes('Stopped'), true, 'an empty stopped answer has a visible status');
  for (const [locale, catalogue, expected] of [
    ['stop-de', mcpPlaygroundDe, 'Angehalten'], ['stop-fr', mcpPlaygroundFr, 'Arrêté'],
    ['stop-it', mcpPlaygroundIt, 'Interrotto'], ['stop-ru', mcpPlaygroundRu, 'Остановлено'],
  ] as const) {
    act(() => { registerLocale(locale, catalogue); setLocale(locale); });
    assert.equal(ui.textContent?.includes(expected), true, `stopped status follows ${locale}`);
  }
});
