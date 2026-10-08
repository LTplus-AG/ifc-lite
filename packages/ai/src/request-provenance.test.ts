/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createRootBudget, restoreRootBudget } from './budget.js';
import { runModelRequest, type TransportCall } from './request.js';
import { chatCompletionsTransport } from './chat-completions.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const output = 'Native output: café 🏗️';
const messages = [{ role: 'user', content: 'private native evidence' }];
const system = 'Read supplied native evidence only';

async function execute(options: { reason?: string | null; messages?: typeof messages; system?: string; usage?: boolean } = {}) {
  const calls: TransportCall<(typeof messages)[number]>[] = [];
  const budget = restoreRootBudget({ maxRequests: 3, maxOutputTokens: 100, requests: 1, outputTokens: 63 });
  if (!budget) throw new Error('Native resumed budget must be valid');
  const request = {
    model: 'native-test', route: 'test', messages: options.messages ?? messages, system: options.system ?? system,
    prepareInput: () => JSON.stringify({ messages: options.messages ?? messages, system: options.system ?? system }),
    maxOutputTokens: 100, routeCeiling: 80, budget, timeoutMs: 123_456, promptVersion: 'native-test.v1',
    transport: async (call: TransportCall<(typeof messages)[number]>) => {
      calls.push(call); call.onChunk(output); call.onFinishReason(options.reason === undefined ? 'stop' : options.reason);
      if (options.usage) call.onTokenUsage({ inputTokens: 21, outputTokens: 3 });
      call.onComplete(output);
    },
  };
  const result = await runModelRequest(request);
  if (result.kind !== 'completed' && result.kind !== 'truncated') throw new Error(`Unexpected native outcome: ${result.kind}`);
  return { result, calls, budget };
}

// #7246 the receipt must describe the native reservation, not requested or estimated tokens.
it('retains the actual native restored-budget grant and parent deadline independently of provider usage', async () => {
  for (const usage of [true, false]) {
    const { result, calls, budget } = await execute({ usage });
    expect(calls[0].maxOutputTokens).toBe(37);
    expect(result.receipt).toMatchObject({ provenance: {
      contractVersion: 'ifc-lite.ai.request.v1', promptVersion: 'native-test.v1',
      grantedOutputTokens: 37, timeoutMs: 123_456, finishReason: 'stop',
    } });
    expect(result.receipt.usageReported).toBe(usage);
    expect(budget.outputTokens).toBe(usage ? 66 : 100);
  }
});

it('retains safe native terminal reasons without arbitrary provider text', async () => {
  for (const [reason, expected] of [['length', 'length'], ['max_tokens', 'max_tokens'], [null, 'unknown'], ['private-provider-error https://secret.invalid', 'unknown']] as const) {
    const { result } = await execute({ reason });
    expect(result.receipt).toMatchObject({ provenance: { finishReason: expected } });
    expect(JSON.stringify(result.receipt)).not.toContain('secret.invalid');
    expect(result.kind).toBe(reason === 'length' || reason === 'max_tokens' ? 'truncated' : 'completed');
  }
});

it('binds exact UTF8 output text and canonical logical input, never raw request content', async () => {
  const { result } = await execute();
  const logical = JSON.stringify({ messages: messages.map(({ role, content }) => ({ content, role })), system, version: 'ifc-lite.ai.logical-input.v1' });
  expect(result.receipt).toMatchObject({ provenance: {
    inputDigest: { algorithm: 'sha256', referent: 'logical-input.v1', value: sha(logical) },
    outputTextDigest: { algorithm: 'sha256', referent: 'output-text.utf8.v1', value: sha(output) },
  } });
  expect(JSON.stringify(result.receipt)).not.toContain('private native evidence');
  expect(JSON.stringify(result.receipt)).not.toContain(output);
});

it('canonicalizes object insertion order but detects changed native evidence and preferences', async () => {
  const a = await execute();
  const b = await execute({ messages: [{ content: messages[0].content, role: 'user' }] });
  const c = await execute({ messages: [{ role: 'user', content: 'changed evidence' }] });
  const d = await execute({ system: `${system}\nFrench language preference` });
  const provenance = (receipt: unknown) => (receipt as { provenance?: { inputDigest?: unknown } }).provenance?.inputDigest;
  expect(provenance(a.result.receipt)).toBeDefined();
  expect(provenance(a.result.receipt)).toEqual(provenance(b.result.receipt));
  expect(provenance(a.result.receipt)).not.toEqual(provenance(c.result.receipt));
  expect(provenance(a.result.receipt)).not.toEqual(provenance(d.result.receipt));
});

it('does not claim dispatched provenance when cancelled before dispatch or refused by budget', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const request = { model: 'native-test', route: 'test', messages, maxOutputTokens: 100, routeCeiling: 80,
    budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), timeoutMs: 100, signal: controller.signal,
    transport: async () => { calls++; } };
  const cancelled = await runModelRequest(request);
  expect(cancelled).toMatchObject({ kind: 'cancelled' });
  if (cancelled.kind !== 'cancelled') throw new Error('Expected pre-dispatch cancellation');
  expect(cancelled.receipt).not.toHaveProperty('provenance');
  const refused = await runModelRequest({ ...request, signal: undefined, budget: { ...request.budget, requests: 1 } });
  expect(refused).toEqual({ kind: 'refused', reason: 'budget-exhausted' });
  expect(calls).toBe(0);
});

it('captures schema and image content in the logical digest without retaining either', async () => {
  async function send(image: string, field: string) {
    const input = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] }];
    const outputSchema = { name: 'native_fields', schema: { type: 'object', properties: { [field]: { type: 'string' } }, required: [field], additionalProperties: false } };
    const result = await runModelRequest({ model: 'native-test', route: 'test', messages: input, outputSchema,
      prepareInput: () => JSON.stringify({ messages: input, outputSchema }),
      budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 100,
      transport: async call => { call.onChunk(output); call.onComplete(output); } });
    if (result.kind !== 'completed') throw new Error('Expected native completion');
    const logical = JSON.stringify({ messages: [{ content: [{ image_url: { url: image }, type: 'image_url' }], role: 'user' }],
      outputSchema: { name: 'native_fields', schema: { additionalProperties: false, properties: { [field]: { type: 'string' } }, required: [field], type: 'object' } }, version: 'ifc-lite.ai.logical-input.v1' });
    expect(result.receipt).toMatchObject({ provenance: { inputDigest: { value: sha(logical) } } });
    expect(JSON.stringify(result.receipt)).not.toContain(image);
    return result.receipt;
  }
  const first = await send('data:image/png;base64,privateImageA', 'Name');
  const second = await send('data:image/png;base64,privateImageB', 'Name');
  const third = await send('data:image/png;base64,privateImageA', 'GlobalId');
  expect(first.provenance?.inputDigest).not.toEqual(second.provenance?.inputDigest);
  expect(first.provenance?.inputDigest).not.toEqual(third.provenance?.inputDigest);
});

it('matches real headless chat-completions wire grant and terminal reason without persisting the endpoint or key', async () => {
  let body: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'length' }], usage: { prompt_tokens: 11, completion_tokens: 2 } }), { status: 200 });
  };
  const result = await runModelRequest({ model: 'native-test', route: 'cli', messages: ['headless private evidence'], system,
    prepareInput: () => JSON.stringify({ messages: ['headless private evidence'], system }),
    maxOutputTokens: 100, routeCeiling: 80, budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 37 }), timeoutMs: 100,
    transport: chatCompletionsTransport({ model: 'native-test', apiKey: 'private-api-key', baseUrl: 'https://private-endpoint.invalid' }, fetchImpl) });
  expect(body?.max_tokens).toBe(37);
  expect(body?.messages).toEqual([{ role: 'system', content: system }, { role: 'user', content: 'headless private evidence' }]);
  expect(result).toMatchObject({ kind: 'truncated', receipt: { usageReported: true, outputTokens: 2, provenance: { grantedOutputTokens: 37, finishReason: 'length' } } });
  if (result.kind !== 'truncated') throw new Error('Expected headless truncation');
  expect(result.receipt.provenance).not.toHaveProperty('promptVersion');
  const sent = body?.messages as { role: string; content: string }[];
  const logicalSent = JSON.stringify({ messages: sent.filter(message => message.role === 'user').map(message => message.content),
    system: sent.find(message => message.role === 'system')?.content, version: 'ifc-lite.ai.logical-input.v1' });
  expect(result.receipt.provenance?.inputDigest?.value).toBe(sha(logicalSent));
  for (const secret of ['private-api-key', 'private-endpoint.invalid', 'headless private evidence']) expect(JSON.stringify(result.receipt)).not.toContain(secret);
});

it('retains dispatched timeout/cancel grants while never claiming a completed-text hash', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const result = await runModelRequest({ model: 'native-test', route: 'test', messages,
      budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 37 }), maxOutputTokens: 100, routeCeiling: 80,
      timeoutMs: cancel ? 100 : 2, signal: controller.signal,
      transport: async call => {
        call.onChunk('partial private output');
        await new Promise<void>(resolve => {
          call.signal.addEventListener('abort', () => resolve(), { once: true });
          if (cancel) controller.abort();
        });
      } });
    expect(result).toMatchObject({ kind: cancel ? 'cancelled' : 'timeout', receipt: { provenance: { grantedOutputTokens: 37, timeoutMs: cancel ? 100 : 2, finishReason: 'unknown' } } });
    if (result.kind !== 'cancelled' && result.kind !== 'timeout') throw new Error('Expected owned interruption');
    expect(result.receipt.provenance).not.toHaveProperty('outputTextDigest');
  }
});

it('keeps generic non-JSON logical input explicitly unknown rather than hashing a guess', async () => {
  const input: { loop?: unknown } = {}; input.loop = input;
  const result = await runModelRequest({ model: 'generic-host', route: 'test', messages: [input],
    budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 100,
    transport: async call => { call.onChunk(output); call.onComplete(output); } });
  expect(result).toMatchObject({ kind: 'completed', receipt: { provenance: { inputDigestUnavailable: 'opaque-input' } } });
  if (result.kind !== 'completed') throw new Error('Expected generic host completion');
  expect(result.receipt.provenance).not.toHaveProperty('inputDigest');
});

it('digests finalized logical input after native onStart observers and omits provenance if an observer cancels dispatch', async () => {
  for (const cancel of [false, true]) {
    const input = [{ role: 'user', content: 'before observer' }];
    let sent = false;
    const result = await runModelRequest({ model: 'native-test', route: 'test', messages: input,
      prepareInput: () => JSON.stringify({ messages: input }),
      budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 100,
      transport: async call => { sent = true; expect(call.messages[0].content).toBe('finalized observer value'); call.onChunk(output); call.onComplete(output); } },
    { onStart: started => { input[0].content = 'finalized observer value'; if (cancel) started.cancel(); } });
    if (result.kind === 'refused') throw new Error('Observer must not cause budget refusal');
    expect(sent).toBe(!cancel);
    if (cancel) expect(result.receipt).not.toHaveProperty('provenance');
    else expect(result.receipt).toMatchObject({ provenance: { inputDigest: { value: sha(JSON.stringify({ messages: [{ content: 'finalized observer value', role: 'user' }], version: 'ifc-lite.ai.logical-input.v1' })) } } });
  }
});

it('never records undeclared non-string or endpoint-shaped prompt versions from a generic JS host', async () => {
  for (const version of [42, 'https://private-endpoint.invalid', 'api-key=PRIVATE_KEY']) {
    const request = { model: 'generic-host', route: 'test', messages,
      budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 100,
      transport: async (call: TransportCall<(typeof messages)[number]>) => { call.onChunk(output); call.onComplete(output); } };
    Reflect.set(request, 'promptVersion', version);
    const result = await runModelRequest(request);
    if (result.kind !== 'completed') throw new Error('Expected generic host completion');
    expect(result.receipt.provenance).toBeDefined();
    expect(result.receipt.provenance).not.toHaveProperty('promptVersion');
  }
});

it('bounds digest-only expansion of shared JSON DAGs without refusing the native host request', async () => {
  let input: unknown = 'leaf';
  for (let depth = 0; depth < 12; depth++) input = [input, input, input];
  let dispatched = false;
  const result = await runModelRequest({ model: 'generic-host', route: 'test', messages: [input],
    prepareInput: () => JSON.stringify({ messages: [input] }),
    budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 10_000,
    transport: async call => { dispatched = true; call.onChunk(output); call.onComplete(output); } });
  expect(dispatched).toBe(true);
  expect(result).toMatchObject({ kind: 'completed', receipt: { provenance: { inputDigestUnavailable: 'digest-limit' } } });
  if (result.kind !== 'completed') throw new Error('Expected native host completion');
  expect(result.receipt.provenance).not.toHaveProperty('inputDigest');
});

it('retains a full digest across the established viewer context and image size contract', async () => {
  // Size/UTF8 metadata invariant only: no claim that this test image is rendered or provider-validated.
  const image = 'A'.repeat(1_200_000), context = 'C'.repeat(90_000);
  const input = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] }];
  const result = await runModelRequest({ model: 'native-test', route: 'test', messages: input, system: context,
    prepareInput: () => JSON.stringify({ messages: input, system: context }),
    budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 10_000,
    transport: async call => { call.onChunk(output); call.onComplete(output); } });
  if (result.kind !== 'completed') throw new Error('Expected completed size-bound request');
  const logical = JSON.stringify({ messages: [{ content: [{ image_url: { url: image }, type: 'image_url' }], role: 'user' }], system: context, version: 'ifc-lite.ai.logical-input.v1' });
  expect(result.receipt).toMatchObject({ provenance: { inputDigest: { value: sha(logical) } } });
  expect(result.receipt.provenance).not.toHaveProperty('inputDigestUnavailable');
});

it('does not dispatch after the actual parent deadline elapsed during native logical hashing', async () => {
  let phaseStarted = 0, handoffElapsed = 0, dispatched = false;
  const budget = createRootBudget({ maxRequests: 1, maxOutputTokens: 100 });
  const result = await runModelRequest({ model: 'native-test', route: 'test', messages: ['A'.repeat(1_200_000)],
    prepareInput: () => JSON.stringify({ messages: ['A'.repeat(1_200_000)] }),
    budget, maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 1,
    transport: async call => {
      dispatched = true; handoffElapsed = performance.now() - phaseStarted;
      call.onChunk(output); call.onComplete(output);
    } }, { onStart: () => { phaseStarted = performance.now(); } });
  const elapsed = performance.now() - phaseStarted;
  expect(elapsed).toBeGreaterThanOrEqual(1); // Measured native preparation exceeded the real timer, no fake clock.
  expect({ kind: result.kind, dispatched, handoffElapsed }).toMatchObject({ kind: 'timeout', dispatched: false });
  if (result.kind !== 'timeout') throw new Error('Expected native pre-handoff timeout');
  expect(result.receipt).not.toHaveProperty('provenance');
  expect(budget.outputTokens).toBe(0);
});

it('leaves accessor-induced caller cancellation to the actual native transport instead of metadata', async () => {
  const controller = new AbortController(); let dispatched = false;
  const message = { role: 'user', get content() { controller.abort(); return 'caller cancelled during preparation'; } };
  const result = await runModelRequest({ model: 'native-test', route: 'test', messages: [message], signal: controller.signal,
    budget: createRootBudget({ maxRequests: 1, maxOutputTokens: 100 }), maxOutputTokens: 100, routeCeiling: 80, timeoutMs: 100,
    transport: async call => { dispatched = true; void call.messages[0].content; call.onChunk(output); call.onComplete(output); } });
  expect(result.kind).toBe('cancelled');
  expect(dispatched).toBe(true);
  if (result.kind !== 'cancelled') throw new Error('Expected native caller cancellation');
  expect(result.receipt).toMatchObject({ provenance: { inputDigestUnavailable: 'opaque-input', grantedOutputTokens: 80 } });
});
