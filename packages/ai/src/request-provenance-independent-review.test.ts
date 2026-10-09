/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRootBudget } from './budget.js';
import { runModelRequest, type TransportCall } from './request.js';

it('#7246 receipt model/route bind the actual transport call despite caller config changes before completion', async () => {
  let dispatchedModel = '';
  const request = { model: 'actually-dispatched-model', route: 'actual-route', messages: ['native input'],
    budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 1000,
    transport: async (call: TransportCall<string>) => {
      dispatchedModel = call.model;
      request.model = 'later-caller-model'; request.route = 'later-caller-route';
      call.onChunk('native completed answer'); call.onFinishReason('stop'); call.onComplete('native completed answer');
    } };
  const result = await runModelRequest(request);
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error('Expected actual completion');
  expect(dispatchedModel).toBe('actually-dispatched-model');
  expect(result.receipt.model).toBe(dispatchedModel);
  expect(result.receipt.route).toBe('actual-route');
});

it('#7246 opaque Proxy metadata must not execute an introspection trap before its accepted native transport', async () => {
  let inspections = 0;
  const data = { content: 'native untouched input' };
  const opaque = new Proxy(data, { getPrototypeOf: target => {
    inspections++; target.content = 'changed by metadata inspection'; return Object.getPrototypeOf(target);
  } });
  const result = await runModelRequest({ model: 'generic-host', route: 'native', messages: [opaque],
    budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 1000,
    transport: async call => { const text = call.messages[0].content; call.onChunk(text); call.onComplete(text); } });
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error('Expected accepted opaque transport');
  expect(inspections).toBe(0);
  expect(result.text).toBe('native untouched input');
  expect(result.receipt.provenance?.inputDigestUnavailable).toBe('opaque-input');
});


it('#7246 explicit producer dispatch and digest share the owned parsed JSON snapshot', async () => {
  const messages = [{ role: 'user', content: 'native snapshot' }];
  const system = 'native system';
  const schema = { name: 'native', schema: { type: 'object', additionalProperties: false, properties: {} } };
  const result = await runModelRequest({ model: 'native', route: 'controlled', messages, system, outputSchema: schema,
    prepareInput: () => JSON.stringify({ messages, system, outputSchema: schema }),
    budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 1000,
    transport: async call => {
      messages[0].content = 'later caller input'; schema.name = 'later caller schema';
      expect(call.messages[0].content).toBe('native snapshot'); expect(call.outputSchema?.name).toBe('native');
      expect(call.messages).not.toBe(messages); expect(call.outputSchema).not.toBe(schema);
      call.onChunk('native snapshot'); call.onComplete('native snapshot');
    } });
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error('Expected native snapshot completion');
  const logical = JSON.stringify({ messages: [{ content: 'native snapshot', role: 'user' }],
    outputSchema: { name: 'native', schema: { additionalProperties: false, properties: {}, type: 'object' } },
    system, version: 'ifc-lite.ai.logical-input.v1' });
  expect(result.receipt.provenance?.inputDigest?.value).toBe(createHash('sha256').update(logical, 'utf8').digest('hex'));
});

it('#7246 malformed or throwing explicit preparation refuses dispatch honestly', async () => {
  for (const prepareInput of [() => '{invalid json', () => JSON.stringify({ messages: 'not an array' }),
    () => { throw new Error('producer preparation failed'); }]) {
    let sent = false;
    const budget = createRootBudget({ maxRequests: 1, maxOutputTokens: 100 });
    const result = await runModelRequest({ model: 'native', route: 'controlled', messages: ['native'], prepareInput,
      budget, maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 1000,
      transport: async call => { sent = true; call.onChunk('native'); call.onComplete('native'); } });
    expect(sent).toBe(false); expect(result.kind).toBe('error'); expect(budget.outputTokens).toBe(0);
    if (result.kind !== 'error') throw new Error('Expected preparation refusal');
    expect(result.receipt.provenance).toBeUndefined();
  }
});

it('#7246 explicit native JSON serialization reads a dynamic value once and dispatches that exact value', async () => {
  let reads = 0;
  const messages = [{ get content() { return `serialized-native-value-${++reads}`; } }];
  const result = await runModelRequest({ model: 'native', route: 'controlled', messages,
    prepareInput: () => JSON.stringify({ messages }),
    budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 1000,
    transport: async call => { const text = call.messages[0].content; call.onChunk(text); call.onComplete(text); } });
  expect(result.kind).toBe('completed'); expect(reads).toBe(1);
  if (result.kind !== 'completed') throw new Error('Expected explicit serialization completion');
  expect(result.text).toBe('serialized-native-value-1');
  const logical = JSON.stringify({ messages: [{ content: result.text }], version: 'ifc-lite.ai.logical-input.v1' });
  expect(result.receipt.provenance?.inputDigest?.value).toBe(createHash('sha256').update(logical, 'utf8').digest('hex'));
});

it('#7246 caller cancellation during explicit native preparation never dispatches or claims a grant reached transport', async () => {
  const controller = new AbortController(); let sent = false;
  const budget = createRootBudget({ maxRequests: 1, maxOutputTokens: 100 });
  const result = await runModelRequest({ model: 'native', route: 'controlled', messages: ['native'],
    signal: controller.signal, prepareInput: () => { controller.abort(); return JSON.stringify({ messages: ['native'] }); },
    budget, maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 1000,
    transport: async call => { sent = true; call.onChunk('native'); call.onComplete('native'); } });
  expect(sent).toBe(false); expect(result.kind).toBe('cancelled'); expect(budget.outputTokens).toBe(0);
  if (result.kind !== 'cancelled') throw new Error('Expected pre-dispatch cancellation');
  expect(result.receipt.provenance).toBeUndefined();
});
