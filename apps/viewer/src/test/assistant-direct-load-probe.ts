/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';
import { mock } from 'node:test';
import type { SendableRoute } from '../lib/llm/request-service.js';

const [provider, scenario, peer] = process.argv.slice(2);
if ((provider !== 'openai' && provider !== 'anthropic')
  || !['abort', 'deadline', 'reject'].includes(scenario ?? '') || !peer) {
  throw new Error('invalid isolated direct-load probe arguments');
}
const controller = new AbortController();
const report = (value: object) => { if (process.connected) process.send?.(value); };
const diagnostic = (stage: string) => report({ kind: 'diagnostic', stage });
diagnostic('probe:start');
const { port1, port2 } = new MessageChannel();
let initialized!: () => void;
const hookReady = new Promise<void>(resolve => { initialized = resolve; });
port1.on('message', message => {
  if (message?.kind === 'diagnostic') {
    report(message);
    if (message.stage === 'hook:initialize') initialized();
  }
});
diagnostic('probe:register:start');
register('./assistant-direct-load-hook.mjs', import.meta.url, {
  data: { port: port2 }, transferList: [port2],
});
diagnostic('probe:register:done');
await hookReady;
diagnostic('probe:hook:ready');

// Every attempted provider/proxy request has a real independently retained
// HTTP receiver. No external provider is contacted with the synthetic key.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const raw = input instanceof Request ? input.url : String(input);
  const target = new URL(raw, 'https://probe.invalid');
  report({ kind: 'fetch', url: target.href });
  if (!['api.openai.com', 'api.anthropic.com', 'probe.invalid'].includes(target.hostname)) {
    throw new Error('unexpected direct-load probe receiver');
  }
  return originalFetch(new URL(`/${target.hostname}${target.pathname}`, peer), init);
};

process.on('message', command => {
  diagnostic(`probe:command:${String(command)}`);
  if (command === 'abort') controller.abort(new Error('controlled caller cancellation'));
  else if (command === 'deadline') mock.timers.tick(1_000);
  // release/reject are consumed by the genuine module's evaluation barrier.
  // A round trip after evaluation lets the import's promise continuations run
  // before the parent checks for any forbidden late provider dispatch.
  else if (command === 'drain') setImmediate(() => report({ kind: 'drained' }));
  else if (command === 'finish') {
    if (scenario === 'deadline') mock.timers.reset();
    globalThis.fetch = originalFetch;
    port1.close();
    process.disconnect?.();
  }
});

// These are existing stable consumers. No new production test export is used.
diagnostic('probe:request-service:import:start');
const { runModelRequest } = await import('../lib/llm/request-service.js');
diagnostic('probe:request-service:import:done');
const { createRootBudget } = await import('../lib/llm/root-budget.js');
const { useRequestReceipts } = await import('../lib/llm/request-receipts.js');
diagnostic('probe:stable-consumers:import:done');
const route: SendableRoute = provider === 'openai'
  ? { kind: 'openai', model: 'gpt-6-sol', apiKey: 'sk-test-7450' }
  : { kind: 'anthropic', model: 'claude-opus-5-5', credentials: { apiKey: 'sk-ant-test-7450', workspaceId: '' } };
if (scenario === 'deadline') mock.timers.enable({ apis: ['setTimeout'] });
diagnostic('probe:request:start');
const outcome = await runModelRequest({
  route, proxyUrl: '/api/chat', messages: [{ role: 'user', content: 'isolated load-boundary control' }],
  maxOutputTokens: 100, budget: createRootBudget(), signal: controller.signal,
  timeoutMs: scenario === 'deadline' ? 1_000 : 10_000,
});
diagnostic('probe:request:done');
const state = useRequestReceipts.getState();
report({ kind: 'outcome', outcome, receipts: state.receipts, inFlight: state.inFlight.length });
