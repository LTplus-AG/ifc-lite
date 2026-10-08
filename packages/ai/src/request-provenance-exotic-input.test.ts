/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { createRootBudget } from './budget.js';
import { runModelRequest, type TransportCall } from './request.js';

async function send<Message>(message: Message, consume: (call: TransportCall<Message>) => string) {
  let dispatched = false;
  const result = await runModelRequest({ model: 'generic-host', route: 'test', messages: [message],
    budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 1000,
    transport: async call => { dispatched = true; const text = consume(call); call.onChunk(text); call.onComplete(text); } });
  expect(dispatched).toBe(true);
  expect(result).toMatchObject({ kind: 'completed', receipt: { provenance: { inputDigestUnavailable: 'non-json-input' } } });
  return result;
}

// #7246 metadata must not read an opaque host's accessor before its native transport does.
it('keeps accessor input unknown and lets only the accepted native transport read its value', async () => {
  let reads = 0;
  const message = { role: 'user', get content() { return `native-value-${++reads}`; } };
  const result = await send(message, call => call.messages[0].content);
  expect(reads).toBe(1);
  expect(result).toMatchObject({ text: 'native-value-1' });
});

it('does not invoke a throwing accessor or turn metadata into an accepted custom transport failure', async () => {
  let reads = 0;
  const message = { get content() { reads++; throw new Error('PRIVATE_INPUT_ERROR'); } };
  await send(message, () => 'accepted opaque host input');
  expect(reads).toBe(0);
});

it('keeps a dynamic proxy unknown without reading its value before native transport', async () => {
  let reads = 0;
  const message = new Proxy({ content: 'descriptor-only' }, { get: (target, key, receiver) => key === 'content' ? `native-value-${++reads}` : Reflect.get(target, key, receiver) });
  const result = await send(message, call => call.messages[0].content);
  expect(reads).toBe(1);
  expect(result).toMatchObject({ text: 'native-value-1' });
});

it('keeps throwing proxy metadata unknown without rejecting the accepted native transport', async () => {
  const message = new Proxy({ content: 'opaque' }, { getPrototypeOf: () => { throw new Error('PRIVATE_PROXY_ERROR'); } });
  const result = await send(message, () => 'accepted opaque proxy');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_PROXY_ERROR');
});
