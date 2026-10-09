/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createRootBudget } from './budget.js';
import type { UsageReceipt } from './receipt.js';
import { runToolTurn, type ToolTurn, type ToolTurnCall, type ToolTurnRequest, type ToolTurnTransport } from './tool-turn.js';

const TOOL = { name: 'lookup', description: 'Look a name up', inputSchema: { type: 'object' }, strict: true } as const;

function request(transport: ToolTurnTransport, overrides: Partial<ToolTurnRequest<'stub'>> = {}): ToolTurnRequest<'stub'> {
  return {
    model: 'stub-model', route: 'stub', transport, system: 'SYSTEM_TEXT', context: 'CONTEXT_TEXT',
    messages: [{ role: 'user', content: 'PROMPT_TEXT' }], tools: [TOOL],
    maxOutputTokens: 1000, routeCeiling: 800, budget: createRootBudget({ maxRequests: 3, maxOutputTokens: 2000 }), timeoutMs: 5_000,
    ...overrides,
  };
}

const toolUse: ToolTurn = {
  content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_call', id: 'call-1', name: 'lookup', input: { q: 'IfcDoor' } }],
  stopReason: 'tool_use',
  usage: { inputTokens: 50, outputTokens: 20 },
};

describe('runToolTurn', () => {
  it('passes tools, system and context through and returns the turn with an exact receipt', async () => {
    const calls: ToolTurnCall[] = [];
    const budget = createRootBudget({ maxRequests: 3, maxOutputTokens: 2000 });
    const receipts: UsageReceipt<'stub'>[] = [];
    const outcome = await runToolTurn(request(async (call) => { calls.push(call); call.onText('Checking.'); return toolUse; }, { budget }),
      { onReceipt: (r) => receipts.push(r) });
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error('expected completed');
    expect(outcome.turn.content[1]).toMatchObject({ type: 'tool_call', name: 'lookup', input: { q: 'IfcDoor' } });
    expect(calls[0]).toMatchObject({ system: 'SYSTEM_TEXT', context: 'CONTEXT_TEXT', maxOutputTokens: 800, tools: [TOOL] });
    expect(budget).toMatchObject({ requests: 1, outputTokens: 20 });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outcome: 'completed', usageReported: true, inputTokens: 50, outputTokens: 20 });
    expect(JSON.stringify(receipts)).not.toMatch(/PROMPT_TEXT|SYSTEM_TEXT|IfcDoor/);
  });

  it('records the model that served the turn after a server-side fallback', async () => {
    const outcome = await runToolTurn(request(async () => ({ ...toolUse, servedModel: 'fallback-model' })));
    if (outcome.kind !== 'completed') throw new Error('expected completed');
    expect(outcome.receipt.model).toBe('fallback-model');
  });

  it('marks a turn cut at the output ceiling as truncated', async () => {
    const outcome = await runToolTurn(request(async () => ({ ...toolUse, stopReason: 'max_tokens' })));
    if (outcome.kind !== 'completed') throw new Error('expected completed');
    expect(outcome.receipt.outcome).toBe('truncated');
  });

  it('refuses without sending when the root budget is spent', async () => {
    let sent = 0;
    const budget = createRootBudget({ maxRequests: 1, maxOutputTokens: 2000 });
    budget.requests = 1;
    const outcome = await runToolTurn(request(async () => { sent += 1; return toolUse; }, { budget }));
    expect(outcome).toEqual({ kind: 'refused', reason: 'budget-exhausted' });
    expect(sent).toBe(0);
  });

  it('turns a transport failure into an error outcome and charges the full reservation when output streamed', async () => {
    const budget = createRootBudget({ maxRequests: 3, maxOutputTokens: 2000 });
    const outcome = await runToolTurn(request(async (call) => { call.onText('partial'); throw new Error('HTTP 529'); }, { budget }));
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('expected error');
    expect(outcome.message).toBe('HTTP 529');
    expect(outcome.receipt.usageReported).toBe(false);
    expect(budget.outputTokens).toBe(800);
  });

  it('charges no output for a failure that streamed nothing', async () => {
    const budget = createRootBudget({ maxRequests: 3, maxOutputTokens: 2000 });
    await runToolTurn(request(async () => { throw new Error('refused connection'); }, { budget }));
    expect(budget).toMatchObject({ requests: 1, outputTokens: 0 });
  });

  it('resolves a caller cancel as cancelled, before and during the turn', async () => {
    const before = new AbortController();
    before.abort();
    expect((await runToolTurn(request(async () => toolUse, { signal: before.signal }))).kind).toBe('cancelled');

    const during = new AbortController();
    const outcome = await runToolTurn(request((call) => new Promise<ToolTurn>((_resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(new Error('aborted')));
      during.abort();
    }), { signal: during.signal }));
    expect(outcome.kind).toBe('cancelled');
  });

  it('resolves a turn that outlives its deadline as timeout', async () => {
    const outcome = await runToolTurn(request((call) => new Promise<ToolTurn>((_resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }), { timeoutMs: 5 }));
    expect(outcome.kind).toBe('timeout');
  });

  it('forwards streamed text and thinking deltas', async () => {
    const text: string[] = [];
    const thinking: string[] = [];
    await runToolTurn(request(async (call) => { call.onThinking('plan'); call.onText('a'); call.onText('b'); return toolUse; },
      { onText: (d) => text.push(d), onThinking: (d) => thinking.push(d) }));
    expect(text).toEqual(['a', 'b']);
    expect(thinking).toEqual(['plan']);
  });
});
