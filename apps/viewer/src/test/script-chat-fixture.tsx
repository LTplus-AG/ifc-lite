/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture';
import { afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { BimReactContext } from '@/sdk/BimProvider';
import { LocalBackend } from '@/sdk/local-backend';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import type { ExtensionHostService } from '@/services/extensions/host';
import { revisionPair } from '@/lib/compare/revision-pair.test-support';
import { updateApiKeys, clearApiKeys } from '@/services/api-keys';
import { useRequestReceipts } from '@/lib/llm/request-receipts';
import { render, cleanup, click, type } from '@/test/render';
import { ChatPanel } from '@/components/viewer/ChatPanel';

const initial = useViewerStore.getState();
const originalFetch = globalThis.fetch;
// Unrelated Extensions chrome needs a host; transport, native script application and IFC queries are real.
export const chromeHost = { emitAction: () => {}, flavors: { getActive: async () => null } } as unknown as ExtensionHostService;
afterEach(() => {
  cleanup();
  act(() => { useViewerStore.getState().clearChatMessages(); useViewerStore.setState(initial, true); clearApiKeys(); });
  useRequestReceipts.setState({ receipts: [], inFlight: [] });
  globalThis.fetch = originalFetch;
});
export const data = (events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
export const code = "console.log('7093 native walls', bim.query.byType('IfcWall').length);";
export const reply = `\`\`\`js\n${code}\n\`\`\``;
export const chatFrames = (text: string, reason = 'stop', usage = true) => data([
  { choices: [{ delta: { content: text }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: reason }], ...(usage ? { usage: { prompt_tokens: 25, completion_tokens: 1, total_tokens: 26 } } : {}) },
]) + 'data: [DONE]\n\n';
export async function mountNative(t: TestContext, model = 'openai/gpt-free') {
  const pair = await revisionPair(t); if (!pair) return null;
  act(() => {
    useViewerStore.getState().clearChatMessages();
    useViewerStore.setState({ models: new Map([['B', pair.head]]), activeModelId: 'B', ifcDataStore: pair.head.ifcDataStore,
      chatActiveModel: model, chatAutoExecute: true, scriptLastResult: null, scriptLastError: null, scriptLastDiagnostics: [], scriptEditorContent: '', scriptEditorRevision: 0 });
    if (model === 'openai/gpt-free') clearApiKeys();
    else updateApiKeys({ openaiKey: 'sk-test-7093', anthropicKey: 'sk-ant-test-7093' });
  });
  const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
  const ui = render(<BimReactContext.Provider value={bim}><ExtensionHostContext.Provider value={chromeHost}><ChatPanel /></ExtensionHostContext.Provider></BimReactContext.Provider>);
  return { ui, pair, bim };
}
export function send(ui: HTMLElement, prompt = 'Count the walls using a script') {
  const input = ui.querySelector<HTMLTextAreaElement>('textarea[aria-label="Chat message"]'); assert.ok(input);
  type(input, prompt);
  const button = ui.querySelector('button[aria-label="Send (Enter)"]'); assert.ok(button); click(button);
}
export function serve(frames: string, status = 200) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input, init) => {
    if (init?.method !== 'POST') return new Response('{}', { status: 200 });
    sent.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return new Response(frames, { status, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  return sent;
}

/** Hold real transport bytes until its native in-flight activity has been observed. */
export function serveGated(frames: string) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  let release: () => void = () => { throw new Error('native transport has not received its response headers'); };
  globalThis.fetch = (async (input, init) => {
    if (init?.method !== 'POST') return new Response('{}');
    sent.push({ url: String(input), body: JSON.parse(String(init.body)) });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      release = () => { controller.enqueue(new TextEncoder().encode(frames)); controller.close(); };
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  return { sent, release: () => release() };
}
