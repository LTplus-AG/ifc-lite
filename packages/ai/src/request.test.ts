/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createRootBudget, remainingBudget, reserveRequest, restoreRootBudget } from './budget.js';
import { runModelRequest, type AiTransport, type ModelRequest, type RequestStart, type TransportCall } from './request.js';
import type { UsageReceipt } from './receipt.js';

type Msg = { role: 'user'; content: string };

/** A transport that plays a script and records what it was asked for. */
function scripted(play: (call: TransportCall<Msg>) => Promise<void> | void): { transport: AiTransport<Msg>; calls: TransportCall<Msg>[] } {
  const calls: TransportCall<Msg>[] = [];
  return { calls, transport: async (call) => { calls.push(call); await play(call); } };
}

const reply = (text: string, finish = 'stop', usage?: { inputTokens: number; outputTokens: number }) => (call: TransportCall<Msg>) => {
  call.onChunk(text);
  call.onFinishReason(finish);
  if (usage) call.onTokenUsage(usage);
  call.onComplete(text);
};

function request(transport: AiTransport<Msg>, overrides: Partial<ModelRequest<Msg, 'stub'>> = {}): ModelRequest<Msg, 'stub'> {
  return {
    model: 'stub-model', route: 'stub', transport, messages: [{ role: 'user', content: 'PROMPT_TEXT' }],
    maxOutputTokens: 1000, routeCeiling: 800, budget: createRootBudget({ maxRequests: 3, maxOutputTokens: 2000 }), timeoutMs: 5_000,
    ...overrides,
  };
}

describe('runModelRequest', () => {
  it('clamps the output ceiling to the route and charges reported usage exactly', async () => {
    const { transport, calls } = scripted(reply('done', 'stop', { inputTokens: 40, outputTokens: 12 }));
    const receipts: UsageReceipt<'stub'>[] = [];
    const budget = createRootBudget({ maxRequests: 3, maxOutputTokens: 2000 });
    const outcome = await runModelRequest(request(transport, { budget }), { onReceipt: (r) => receipts.push(r) });
    expect(outcome.kind).toBe('completed');
    expect(calls[0].maxOutputTokens).toBe(800);
    expect(budget).toMatchObject({ requests: 1, outputTokens: 12 });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ model: 'stub-model', route: 'stub', outcome: 'completed', usageReported: true, inputTokens: 40, outputTokens: 12 });
    expect(JSON.stringify(receipts)).not.toContain('PROMPT_TEXT');
    expect(JSON.stringify(receipts)).not.toContain('done');
  });

  it('charges the full reservation when output streamed without a usage report', async () => {
    const { transport } = scripted(reply('text'));
    const budget = createRootBudget({ maxRequests: 3, maxOutputTokens: 2000 });
    const outcome = await runModelRequest(request(transport, { budget }));
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error('Expected a completed request');
    expect(outcome.receipt.usageReported).toBe(false);
    expect(budget.outputTokens).toBe(800);
  });

  it('reports truncation at the ceiling as its own outcome', async () => {
    const { transport } = scripted(reply('{"partial":', 'length'));
    const outcome = await runModelRequest(request(transport));
    expect(outcome).toMatchObject({ kind: 'truncated', finishReason: 'length', text: '{"partial":' });
  });

  it('refuses without calling the transport once the root is exhausted, across separate requests', async () => {
    const { transport, calls } = scripted(reply('ok', 'stop', { inputTokens: 1, outputTokens: 1 }));
    const budget = createRootBudget({ maxRequests: 2, maxOutputTokens: 2000 });
    await runModelRequest(request(transport, { budget }));
    await runModelRequest(request(transport, { budget }));
    const third = await runModelRequest(request(transport, { budget }));
    expect(third).toEqual({ kind: 'refused', reason: 'budget-exhausted' });
    expect(calls).toHaveLength(2);
    expect(remainingBudget(budget).maxRequests).toBe(0);
  });

  it('gives a request only what the root has left of its output tokens', async () => {
    const { transport, calls } = scripted(reply('ok'));
    const budget = createRootBudget({ maxRequests: 5, maxOutputTokens: 1000 });
    await runModelRequest(request(transport, { budget }));
    await runModelRequest(request(transport, { budget }));
    expect(calls.map((c) => c.maxOutputTokens)).toEqual([800, 200]);
  });

  it('resolves a caller abort as cancelled and an elapsed deadline as timeout', async () => {
    const hang = scripted((call) => new Promise<void>((resolve) => call.signal.addEventListener('abort', () => resolve())));
    const controller = new AbortController();
    const pending = runModelRequest(request(hang.transport, { signal: controller.signal }));
    controller.abort();
    expect((await pending).kind).toBe('cancelled');
    const timeout = await runModelRequest(request(hang.transport, { timeoutMs: 5 }));
    expect(timeout.kind).toBe('timeout');
  });

  it('cancels before dispatch without spending budget', async () => {
    const { transport, calls } = scripted(reply('ok'));
    const budget = createRootBudget({ maxRequests: 1, maxOutputTokens: 100 });
    const controller = new AbortController();
    controller.abort();
    const outcome = await runModelRequest(request(transport, { budget, signal: controller.signal }));
    expect(outcome.kind).toBe('cancelled');
    expect(calls).toHaveLength(0);
    expect(budget.requests).toBe(0);
  });

  it('separates transport failure from an empty reply, and charges a silent failure no output', async () => {
    const failing = scripted(() => { throw new Error('socket closed'); });
    const budget = createRootBudget({ maxRequests: 5, maxOutputTokens: 2000 });
    expect(await runModelRequest(request(failing.transport, { budget }))).toMatchObject({ kind: 'error', code: 'request-failed', message: 'socket closed' });
    expect(budget).toMatchObject({ requests: 1, outputTokens: 0 });
    const empty = scripted((call) => call.onComplete('   '));
    expect(await runModelRequest(request(empty.transport))).toMatchObject({ kind: 'error', code: 'empty-output' });
  });
});

describe('request start hook', () => {
  it('#7037: settles an announced request and emits its error receipt when the start hook throws', async () => {
    const { transport, calls } = scripted(reply('ok'));
    const budget = createRootBudget({ maxRequests: 3, maxOutputTokens: 2000 });
    const started: RequestStart<'stub'>[] = [];
    const receipts: UsageReceipt<'stub'>[] = [];
    const outcome = await runModelRequest(request(transport, { budget }), {
      onStart: start => { started.push(start); throw new Error('start hook failed'); },
      onReceipt: receipt => receipts.push(receipt),
    });
    expect(outcome).toMatchObject({ kind: 'error', code: 'request-failed', message: 'start hook failed' });
    expect(calls).toHaveLength(0);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ id: started[0].id, outcome: 'error' });
    expect(remainingBudget(budget)).toEqual({ maxRequests: 2, maxOutputTokens: 2000 });
  });
  it('announces a dispatched request with the id its receipt will carry, and its cancel aborts the request', async () => {
    const hang = scripted((call) => new Promise<void>((resolve) => call.signal.addEventListener('abort', () => resolve())));
    const started: RequestStart<'stub'>[] = [];
    const receipts: UsageReceipt<'stub'>[] = [];
    const pending = runModelRequest(request(hang.transport), { onStart: (s) => started.push(s), onReceipt: (r) => receipts.push(r) });
    await Promise.resolve();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ model: 'stub-model', route: 'stub' });
    started[0].cancel();
    expect((await pending).kind).toBe('cancelled');
    expect(receipts.map((r) => r.id)).toEqual([started[0].id]);
  });

  it('announces nothing for a request that was refused or cancelled before dispatch', async () => {
    const { transport } = scripted(reply('ok'));
    const started: RequestStart<'stub'>[] = [];
    const budget = createRootBudget({ maxRequests: 1, maxOutputTokens: 100 });
    budget.requests = 1;
    expect((await runModelRequest(request(transport, { budget }), { onStart: (s) => started.push(s) })).kind).toBe('refused');
    const controller = new AbortController();
    controller.abort();
    await runModelRequest(request(transport, { signal: controller.signal }), { onStart: (s) => started.push(s) });
    expect(started).toEqual([]);
  });
});

describe('reserveRequest', () => {
  it.each([NaN, Infinity, -Infinity, 1.5, 0, -1])('#7037: refuses invalid token ceiling %s without corrupting the next request', ceiling => {
    const budget = createRootBudget({ maxRequests: 2, maxOutputTokens: 100 });
    expect(reserveRequest(budget, ceiling)).toBeNull();
    expect(reserveRequest(budget, 80)).toEqual({ maxOutputTokens: 80 });
    expect(reserveRequest(budget, 80)).toEqual({ maxOutputTokens: 20 });
    expect(reserveRequest(budget, 1)).toBeNull();
  });
});

describe('restoreRootBudget', () => {
  it('round-trips a spent budget and rejects malformed values', () => {
    const budget = createRootBudget({ maxRequests: 4, maxOutputTokens: 100 });
    budget.requests = 2;
    budget.outputTokens = 60;
    expect(restoreRootBudget(JSON.parse(JSON.stringify(budget)))).toEqual(budget);
    expect(restoreRootBudget({ ...budget, requests: -1 })).toBeNull();
    expect(restoreRootBudget({ ...budget, maxRequests: 0 })).toBeNull();
    expect(restoreRootBudget('budget')).toBeNull();
  });
});
