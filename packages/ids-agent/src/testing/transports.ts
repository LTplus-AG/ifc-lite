/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model doubles for tests and for the P-08 eval runner: nothing here calls a
 * provider.
 *
 * - `scriptedTransport`: plays turns written in the test, each a fixed turn
 *   or a function of what the agent sent (so a script can react to a gate
 *   rejection, as a real model would).
 * - `recordingTransport` wraps a live transport and captures every turn as
 *   a `RecordedTranscript` (JSON, no credentials, no request bodies).
 * - `replayTransport` plays a recorded transcript back deterministically, so
 *   CI replays orchestration without a key (`06-ai-agent.md` §9 harness).
 */

import type { ContentBlock, ToolTurn, ToolTurnCall, ToolTurnStopReason, ToolTurnTransport } from '@ifc-lite/ai';

export type ScriptStep = ToolTurn | ((call: ToolTurnCall, index: number) => ToolTurn);

export interface ScriptedTransport {
  transport: ToolTurnTransport;
  /** Every call the agent made, in order. */
  calls: ToolTurnCall[];
}

export function scriptedTransport(steps: readonly ScriptStep[]): ScriptedTransport {
  const calls: ToolTurnCall[] = [];
  return {
    calls,
    transport: async (call) => {
      const index = calls.length;
      calls.push(call);
      const step = steps[index];
      if (!step) throw new Error(`script exhausted after ${steps.length} turns`);
      const turn = typeof step === 'function' ? step(call, index) : step;
      for (const block of turn.content) if (block.type === 'text') call.onText(block.text);
      return turn;
    },
  };
}

let callCounter = 0;

/** A tool call block. */
export function toolCall(name: string, input: unknown, id = `call-${++callCounter}`): ContentBlock {
  return { type: 'tool_call', id, name, input };
}

/** A turn; the stop reason defaults to `tool_use` when it calls a tool, else `end_turn`. */
export function turn(content: readonly ContentBlock[], stopReason?: ToolTurnStopReason, usage = { inputTokens: 100, outputTokens: 50 }): ToolTurn {
  return { content, stopReason: stopReason ?? (content.some((b) => b.type === 'tool_call') ? 'tool_use' : 'end_turn'), usage };
}

/** The tool results the agent sent in the latest message of a call. */
export function lastResults(call: ToolTurnCall): { callId: string; isError: boolean; data: unknown }[] {
  const last = call.messages[call.messages.length - 1];
  if (!last || last.role !== 'tool') return [];
  return last.results.map((r) => ({ callId: r.callId, isError: r.isError, data: JSON.parse(r.content) as unknown }));
}

export interface RecordedTranscript {
  format: 'ids-agent-transcript';
  version: 1;
  /** The model the turns came from. */
  model: string;
  turns: ToolTurn[];
}

export function recordingTransport(inner: ToolTurnTransport): { transport: ToolTurnTransport; transcript(model: string): RecordedTranscript } {
  const turns: ToolTurn[] = [];
  return {
    transport: async (call) => {
      const result = await inner(call);
      turns.push(structuredClone(result));
      return result;
    },
    transcript: (model) => ({ format: 'ids-agent-transcript', version: 1, model, turns: structuredClone(turns) }),
  };
}

/** Validate a parsed transcript file. */
export function parseTranscript(value: unknown): RecordedTranscript {
  const v = value as Partial<RecordedTranscript> | null;
  if (!v || v.format !== 'ids-agent-transcript' || v.version !== 1 || !Array.isArray(v.turns) || typeof v.model !== 'string') {
    throw new Error('Not an ids-agent transcript (format "ids-agent-transcript", version 1).');
  }
  return v as RecordedTranscript;
}

export function replayTransport(transcript: RecordedTranscript): ToolTurnTransport {
  let index = 0;
  return async (call) => {
    const recorded = transcript.turns[index++];
    if (!recorded) throw new Error(`transcript exhausted after ${transcript.turns.length} turns`);
    const result = structuredClone(recorded);
    for (const block of result.content) if (block.type === 'text') call.onText(block.text);
    return result;
  };
}
