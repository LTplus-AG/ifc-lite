/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One tool-calling model turn with a typed outcome, independent of the
 * provider.
 *
 * `runModelRequest` carries text; an agent needs the model to call tools. This
 * module is the same request core for that shape: a provider-neutral message
 * and content-block contract, a transport that a provider adapter implements
 * (Anthropic Messages, OpenAI Chat Completions, a scripted fake), and the
 * same deadline, cancellation, root-budget reservation and usage receipt as
 * every other request in ifc-lite.
 *
 * Tool inputs arrive as parsed JSON (or as the raw text when the provider's
 * JSON could not be parsed). The core never runs a tool and never validates
 * an input: the caller's registry does both, so a hallucinated or truncated
 * call becomes a tool error the model sees, not a crash.
 */

import { reserveRequest, settleRequest, type RootBudget } from './budget.js';
import type { UsageReceipt } from './receipt.js';
import type { TokenUsage } from './usage.js';

/** A tool the model may call. `inputSchema` is a JSON Schema object. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Ask the provider to constrain inputs to the schema, where it can. */
  readonly strict: boolean;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  /** `input` is the parsed JSON; `rawInput` is set instead when it did not parse. */
  | { type: 'tool_call'; id: string; name: string; input: unknown; rawInput?: string }
  /**
   * A provider block the agent does not interpret (thinking, a refusal
   * fallback marker) that must be sent back unchanged on the next turn.
   */
  | { type: 'opaque'; provider: string; value: unknown };

export interface ToolResult {
  readonly callId: string;
  readonly content: string;
  readonly isError: boolean;
}

export type ToolTurnMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: readonly ContentBlock[] }
  /** The results of every call of the preceding assistant turn, in one message. */
  | { role: 'tool'; results: readonly ToolResult[] };

export type ToolTurnStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'other';

/** What a provider adapter returns for one turn. */
export interface ToolTurn {
  readonly content: readonly ContentBlock[];
  readonly stopReason: ToolTurnStopReason;
  /** Provider-reported; null when the provider did not report a complete count. */
  readonly usage: TokenUsage | null;
  /** The model that actually served the turn (a server-side fallback may differ). */
  readonly servedModel?: string;
  readonly refusal?: { category: string | null; explanation: string | null };
}

/** Reasoning effort, mapped by each adapter to what its provider supports. */
export type ToolTurnEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ToolTurnCall {
  readonly model: string;
  /** The stable, cacheable instructions. */
  readonly system: string;
  /** Volatile context (document snapshot, model stats), placed after the cache breakpoint. */
  readonly context?: string;
  readonly messages: readonly ToolTurnMessage[];
  readonly tools: readonly ToolSpec[];
  readonly effort?: ToolTurnEffort;
  /** Advisory token budget for the whole agent task, where the provider supports one. */
  readonly taskBudget?: number;
  /** Already clamped to the route ceiling and the root budget's remainder. */
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
  onText(delta: string): void;
  onThinking(delta: string): void;
}

/** Carries one turn. Like `AiTransport` it must not retry on its own. */
export type ToolTurnTransport = (call: ToolTurnCall) => Promise<ToolTurn>;

export interface ToolTurnRequest<Route extends string = string> {
  readonly model: string;
  readonly route: Route;
  readonly transport: ToolTurnTransport;
  readonly system: string;
  readonly context?: string;
  readonly messages: readonly ToolTurnMessage[];
  readonly tools: readonly ToolSpec[];
  readonly effort?: ToolTurnEffort;
  readonly taskBudget?: number;
  readonly maxOutputTokens: number;
  readonly routeCeiling: number;
  readonly budget: RootBudget;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly onText?: (delta: string) => void;
  readonly onThinking?: (delta: string) => void;
}

export type ToolTurnOutcome<Route extends string = string> =
  /** The provider answered; read `turn.stopReason` (a model refusal is an answer too). */
  | { kind: 'completed'; turn: ToolTurn; receipt: UsageReceipt<Route> }
  | { kind: 'cancelled'; receipt: UsageReceipt<Route> }
  | { kind: 'timeout'; receipt: UsageReceipt<Route> }
  | { kind: 'error'; message: string; receipt: UsageReceipt<Route> }
  /** Nothing was sent: the root budget has no request or output left. */
  | { kind: 'refused'; reason: 'budget-exhausted' };

let turnSequence = 0;

function streamed(turn: ToolTurn | null, sawDelta: boolean): boolean {
  return sawDelta || (turn !== null && turn.content.length > 0);
}

/** Run one tool-calling turn through `transport`, with budget, deadline, cancellation and a receipt. */
export async function runToolTurn<Route extends string>(
  request: ToolTurnRequest<Route>,
  hooks: { readonly onReceipt?: (receipt: UsageReceipt<Route>) => void } = {},
): Promise<ToolTurnOutcome<Route>> {
  const { budget, signal } = request;
  let startedAt = Date.now();
  const id = `turn-${startedAt}-${++turnSequence}`;
  const receiptFor = (outcome: UsageReceipt['outcome'], usage: TokenUsage | null, model = request.model): UsageReceipt<Route> => ({
    id, model, route: request.route, startedAt, finishedAt: Date.now(), outcome,
    ...(usage ? { usageReported: true as const, ...usage } : { usageReported: false as const }),
  });
  if (signal?.aborted) return { kind: 'cancelled', receipt: receiptFor('cancelled', null) };
  const grant = reserveRequest(budget, Math.min(request.maxOutputTokens, request.routeCeiling));
  if (!grant) return { kind: 'refused', reason: 'budget-exhausted' };

  startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const deadline = setTimeout(() => { timedOut = true; controller.abort(new Error('request-timeout')); }, request.timeoutMs);

  let turn: ToolTurn | null = null;
  let failure: Error | null = null;
  let sawDelta = false;
  try {
    turn = await request.transport({
      model: request.model,
      system: request.system,
      context: request.context,
      messages: request.messages,
      tools: request.tools,
      effort: request.effort,
      taskBudget: request.taskBudget,
      maxOutputTokens: grant.maxOutputTokens,
      signal: controller.signal,
      onText: (delta) => { sawDelta = true; request.onText?.(delta); },
      onThinking: (delta) => { sawDelta = true; request.onThinking?.(delta); },
    });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abortFromCaller);
  }

  const usage = turn?.usage ?? null;
  settleRequest(budget, grant, usage ? usage.outputTokens : streamed(turn, sawDelta) ? null : 0);
  const finish = (outcome: UsageReceipt['outcome']): UsageReceipt<Route> => {
    const receipt = receiptFor(outcome, usage, turn?.servedModel ?? request.model);
    hooks.onReceipt?.(receipt);
    return receipt;
  };
  if (timedOut) return { kind: 'timeout', receipt: finish('timeout') };
  if (controller.signal.aborted) return { kind: 'cancelled', receipt: finish('cancelled') };
  if (failure || !turn) return { kind: 'error', message: failure?.message ?? 'no turn', receipt: finish('error') };
  return { kind: 'completed', turn, receipt: finish(turn.stopReason === 'max_tokens' ? 'truncated' : 'completed') };
}
