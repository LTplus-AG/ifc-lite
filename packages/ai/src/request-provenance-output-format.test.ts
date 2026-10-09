/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { createRootBudget } from './budget.js';
import { runModelRequest, type TransportCall } from './request.js';
import type { JsonResponseSchema, OutputFormat } from './response-schema.js';

const schema: JsonResponseSchema = {
  name: 'native-dispatched-schema',
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

const options = () => ({ model: 'native', route: 'controlled', messages: ['native input'],
  budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }),
  maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 1000 });

function finish(call: TransportCall<string>): void {
  call.onChunk('{}'); call.onComplete('{}');
}

it('#7246 records the output protocol for a schema supplied only by the explicit input producer', async () => {
  let observed: JsonResponseSchema | undefined;
  const result = await runModelRequest({ ...options(),
    prepareInput: () => JSON.stringify({ messages: ['native input'], outputSchema: schema }),
    transport: async call => {
      observed = call.outputSchema;
      call.onOutputFormat?.('json-schema'); finish(call);
    } });
  expect(observed).toEqual(schema);
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error('Expected native dispatch completion');
  expect(result.receipt.outputFormat).toBe('json-schema');
});

it('#7246 does not claim a protocol when the producer omits the original caller schema', async () => {
  let observed: JsonResponseSchema | undefined;
  const result = await runModelRequest({ ...options(), outputSchema: schema,
    prepareInput: () => JSON.stringify({ messages: ['native input'] }),
    transport: async call => {
      observed = call.outputSchema;
      call.onOutputFormat?.('text'); finish(call);
    } });
  expect(observed).toBeUndefined();
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error('Expected native dispatch completion');
  expect(result.receipt.outputFormat).toBeUndefined();
});

it.each([true, false])('#7246 caller schema mutation during transport cannot rewrite dispatched protocol: initial=%s', async initiallyDeclared => {
  let observed: JsonResponseSchema | undefined;
  const request = { ...options(), outputSchema: initiallyDeclared ? schema : undefined,
    transport: async (call: TransportCall<string>) => {
      observed = call.outputSchema;
      const format: OutputFormat = call.outputSchema ? 'json-schema' : 'text';
      call.onOutputFormat?.(format);
      request.outputSchema = initiallyDeclared ? undefined : schema;
      finish(call);
    } };
  const result = await runModelRequest(request);
  expect(observed).toBe(initiallyDeclared ? schema : undefined);
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error('Expected native dispatch completion');
  expect(result.receipt.outputFormat).toBe(initiallyDeclared ? 'json-schema' : undefined);
});

it('#7246 preserves a transport-reported text fallback for an actually dispatched schema', async () => {
  const result = await runModelRequest({ ...options(), outputSchema: schema,
    transport: async call => { call.onOutputFormat?.('text'); finish(call); } });
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error('Expected native dispatch completion');
  expect(result.receipt.outputFormat).toBe('text');
});

it('#7246 leaves an unreported output protocol unknown even with a dispatched schema', async () => {
  const result = await runModelRequest({ ...options(), outputSchema: schema,
    transport: async call => { finish(call); } });
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error('Expected native dispatch completion');
  expect(result.receipt.outputFormat).toBeUndefined();
});
