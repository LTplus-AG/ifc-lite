/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createRootBudget, type ToolTurn } from '@ifc-lite/ai';
import { describe, expect, it } from 'vitest';
import { scriptedTransport, toolCall, turn, createFakeModelBridge } from '../testing/index.js';
import { doorOps, emptyDoc, schemaContexts } from '../../test/helpers.js';
import { runAgent, DEFAULT_AGENT_MODEL, type AgentEvent, type AgentRunOptions } from './loop.js';
import { MODES } from '../modes.js';

async function options(steps: Parameters<typeof scriptedTransport>[0], extra: Partial<AgentRunOptions> = {}) {
  const { gate, lint } = await schemaContexts();
  const scripted = scriptedTransport(steps);
  return { scripted, options: { transport: scripted.transport, mode: 'draft' as const, request: 'Doors need a fire rating.', doc: emptyDoc(), gate, lint, ...extra } };
}

const lookup = () => turn([toolCall('schema_search_entities', { query: 'door', version: 'IFC4' })]);
const done = (text = 'Done.') => turn([{ type: 'text', text }]);

describe('agent loop', () => {
  it('sends the default model, mode effort, task budget, frozen system prompt, context and the mode tools', async () => {
    const { scripted, options: o } = await options([lookup(), done()]);
    const run = await runAgent(o);
    expect(run.status).toBe('completed');
    const [first, second] = scripted.calls;
    expect(first.model).toBe(DEFAULT_AGENT_MODEL);
    expect(first.effort).toBe('high');
    expect(first.taskBudget).toBe(MODES.draft.taskBudget);
    expect(first.system).toBe(second.system);
    expect(first.context).toContain('Current IDS document');
    expect(first.context).toBe(second.context);
    expect(first.tools.map((t) => t.name)).toContain('ids_apply_ops');
    // Append-only: the second request extends the first.
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(second.messages).toHaveLength(3);
  });

  it('stops when the root budget is exhausted and still returns the proposal so far', async () => {
    const forever = (): ToolTurn => turn([toolCall('ids_apply_ops', { ops: doorOps('Pset_DoorCommon', 'FireRating', `@d${Math.random().toString(36).slice(2, 8)}`) })]);
    const { options: o } = await options([forever, forever, forever, forever], { budget: createRootBudget({ maxRequests: 2, maxOutputTokens: 100_000 }) });
    const run = await runAgent(o);
    expect(run.status).toBe('budget-exhausted');
    expect(run.proposal.batches).toHaveLength(2);
    expect(run.proposal.receipt.totals.requests).toBe(2);
    expect(run.sent).toHaveLength(2);
  });

  it('stops on no progress: the same failure signature twice in a row', async () => {
    const bad = () => turn([toolCall('ids_apply_ops', { ops: doorOps('Pset_DoorFireSafety', 'FireRating') })]);
    const { scripted, options: o } = await options([bad, bad, bad, done()]);
    const run = await runAgent(o);
    expect(run.status).toBe('no-progress');
    expect(run.message).toContain('GATE-PSET-001');
    expect(scripted.calls).toHaveLength(2);
  });

  it('a different failure resets the no-progress signature', async () => {
    const bad = (pset: string) => () => turn([toolCall('ids_apply_ops', { ops: doorOps(pset, 'FireRating') })]);
    const { scripted, options: o } = await options([bad('Pset_DoorFireSafety'), bad('Pset_DoorMagic'), done()]);
    expect((await runAgent(o)).status).toBe('completed');
    expect(scripted.calls).toHaveLength(3);
  });

  it('streams text and thinking, emits tool events and receipts, and records totals and a digest', async () => {
    const events: AgentEvent['type'][] = [];
    const { options: o } = await options([
      (call) => { call.onThinking('Looking up doors'); return lookup(); },
      done('All good.'),
    ], { onEvent: (e) => events.push(e.type), pricing: { inputPerMTok: 4, outputPerMTok: 20 } });
    const run = await runAgent(o);
    expect(events).toEqual(['request', 'thinking', 'receipt', 'tool-call', 'tool-result', 'request', 'text', 'receipt', 'stopped']);
    expect(run.proposal.receipt.totals).toEqual({ requests: 2, inputTokens: 200, outputTokens: 100, usageComplete: true });
    expect(run.proposal.receipt.costUsd).toBeCloseTo((200 * 4 + 100 * 20) / 1e6, 9);
    expect(run.proposal.receipt.toolCalls).toMatchObject([{ turn: 0, name: 'schema_search_entities', ok: true }]);
    expect(run.proposal.receipt.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(run.proposal.receipt)).not.toContain('Doors need a fire rating');
  });

  it('cancels mid-run on the caller signal', async () => {
    const controller = new AbortController();
    const { options: o } = await options([lookup(), lookup(), done()], {
      signal: controller.signal,
      onEvent: (e) => { if (e.type === 'tool-result') controller.abort(); },
    });
    const run = await runAgent(o);
    expect(run.status).toBe('cancelled');
    expect(run.sent).toHaveLength(1);
  });

  it('stops at the wall-clock cap', async () => {
    const { options: o } = await options([lookup(), lookup(), done()], { limits: { wallClockMs: 0 } });
    expect((await runAgent(o)).status).toBe('wall-clock');
  });

  it('never runs a tool call cut off at max_tokens, and tells the model', async () => {
    const { scripted, options: o } = await options([
      turn([toolCall('ids_apply_ops', { ops: doorOps() })], 'max_tokens'),
      done(),
    ]);
    const run = await runAgent(o);
    expect(run.proposal.batches).toHaveLength(0);
    const last = scripted.calls[1].messages[2];
    expect(last.role === 'tool' && last.results[0].isError).toBe(true);
    expect(run.status).toBe('completed');
  });

  it('reports a refusal, a truncated answer, a provider error and continues after pause_turn', async () => {
    const refusal: ToolTurn = { content: [], stopReason: 'refusal', usage: null, refusal: { category: 'cyber', explanation: 'declined' } };
    let o = (await options([refusal])).options;
    expect(await runAgent(o)).toMatchObject({ status: 'refused', message: 'declined' });
    o = (await options([turn([{ type: 'text', text: 'partial' }], 'max_tokens')])).options;
    expect((await runAgent(o)).status).toBe('truncated');
    const failing = (await options([])).options;
    expect(await runAgent(failing)).toMatchObject({ status: 'error', message: 'script exhausted after 0 turns' });
    const paused = await options([turn([], 'pause_turn'), done('resumed')]);
    const run = await runAgent(paused.options);
    expect(run.status).toBe('completed');
    expect(paused.scripted.calls).toHaveLength(2);
    expect(run.proposal.summary).toBe('resumed');
  });

  it('Infer mode needs a model; with one it offers model tools and adds live previews', async () => {
    const without = (await options([done()], { mode: 'infer' })).options;
    expect(await runAgent(without)).toMatchObject({ status: 'error' });
    const bridge = createFakeModelBridge([{ entity: 'IfcDoor', properties: { 'Pset_DoorCommon.FireRating': 'EI30' } }, { entity: 'IfcWall' }]);
    const { scripted, options: o } = await options([turn([toolCall('ids_apply_ops', { ops: doorOps() })]), done()], { mode: 'infer', modelBridge: bridge });
    const run = await runAgent(o);
    expect(scripted.calls[0].tools.map((t) => t.name)).toContain('model_infer');
    const specId = run.proposal.batches[0].specIds[0];
    expect(run.proposal.previews[specId]).toMatchObject({ applicable: 1, passing: 1, failing: 0 });
  });

  it('records the asked questions in the proposal', async () => {
    const { options: o } = await options([
      turn([toolCall('ids_ask_user', { question: 'Which set?', choices: [{ label: 'A', ops: doorOps() }, { label: 'B', ops: [] }] })]),
      done(),
    ], { askUser: async () => 1 });
    const run = await runAgent(o);
    expect(run.proposal.questions).toEqual([{ id: expect.any(String), question: 'Which set?', choices: ['A', 'B'], picked: 1 }]);
  });
});
