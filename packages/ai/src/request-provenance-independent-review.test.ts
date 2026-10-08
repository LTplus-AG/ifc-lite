/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
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
  expect(result.receipt.provenance?.inputDigestUnavailable).toBe('non-json-input');
  expect(inspections).toBe(0);
  expect(result.text).toBe('native untouched input');
});
