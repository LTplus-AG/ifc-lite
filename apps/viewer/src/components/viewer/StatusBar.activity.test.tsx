/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { advance, cleanup, click, render } from '@/test/render.js';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider.js';
import { ExtensionHostService } from '@/services/extensions/host.js';
import { runModelRequest } from '@/lib/llm/request-service';
import { createRootBudget } from '@/lib/llm/root-budget';
import { StatusBar } from './StatusBar.js';
import { ShellStoreEffects } from './ShellStoreEffects.js';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; sessionStorage.clear(); });

// #6952: exercise the actual status-bar entry and the existing request pipeline.
// Keeping the observer on these established APIs lets the full revert oracle
// run its assertions even when the newly introduced journal files are removed.
test('the status-bar activity entry opens the outcome of an actual streamed assistant request (#6952)', async () => {
  const host = new ExtensionHostService({ sdk: createBimContext({ transport: {
    send: () => Promise.reject(new Error('SDK transport is not used by this test')),
    subscribe: () => () => {}, close: () => {},
  } }) });
  render(<ExtensionHostContext.Provider value={host}><ShellStoreEffects /><StatusBar /></ExtensionHostContext.Provider>);
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  await act(async () => {
    const outcome = await runModelRequest({
      route: { kind: 'proxy', model: 'test/model' }, proxyUrl: '/api/chat',
      messages: [{ role: 'user', content: 'Summarize the results' }],
      maxOutputTokens: 100, budget: createRootBudget(), timeoutMs: 1000,
    });
    assert.equal(outcome.kind, 'completed');
  });
  const entry = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.getAttribute('aria-label') === 'Activity');
  assert.ok(entry, 'the status bar exposes the Activity entry');
  click(entry);
  for (let attempt = 0; attempt < 200 && !document.querySelector('[aria-label="Jobs"]'); attempt++) await advance(20);
  const jobs = document.querySelector('[aria-label="Jobs"]');
  assert.ok(jobs, 'the entry opens the shared job list');
  assert.match(jobs.textContent ?? '', /Assistant request/);
  assert.match(jobs.textContent ?? '', /test\/model/);
  assert.match(jobs.textContent ?? '', /Complete/);
});
