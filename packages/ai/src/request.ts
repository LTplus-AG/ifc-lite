/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One cancellable, time-limited model request with a typed outcome,
 * independent of how the bytes travel.
 *
 * The caller supplies a transport (a browser SSE client, a BYOK provider
 * client, a headless host's own HTTP call, a test stub). This module owns
 * what every caller otherwise re-implements: the overall deadline,
 * cancellation, output-budget clamping against the route ceiling and the
 * task's root budget, and a usage receipt for every request that reached the
 * transport.
 */

import { reserveRequest, settleRequest, type RootBudget } from './budget.js';
import type { UsageReceipt } from './receipt.js';
import type { TokenUsage } from './usage.js';
import type { JsonResponseSchema, OutputFormat } from './response-schema.js';

/**
 * What a transport is asked to do. Every piece of output goes through
 * `onChunk` (a non-streaming transport calls it once with the whole text):
 * a request that never chunked is settled as having produced no output.
 * `onComplete` carries the full text.
 */
export interface TransportCall<Message> {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly system?: string;
  readonly outputSchema?: JsonResponseSchema;
  /** Transport reports the format it actually places on the outgoing request. */
  onOutputFormat?(format: OutputFormat): void;
  /** Already clamped to the route ceiling and the root budget's remainder. */
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
  onChunk(text: string): void;
  onFinishReason(reason: string | null): void;
  onComplete(text: string): void;
  onError(error: Error): void;
  onTokenUsage(usage: TokenUsage): void;
}

/**
 * Carries one call. It must not retry on its own: a retry is a new request
 * that spends the root budget again, and only the caller may decide that.
 */
export type AiTransport<Message> = (call: TransportCall<Message>) => Promise<void>;

export interface ModelRequest<Message, Route extends string = string> {
  readonly model: string;
  /** Recorded on the receipt. */
  readonly route: Route;
  readonly transport: AiTransport<Message>;
  readonly messages: readonly Message[];
  readonly system?: string;
  readonly outputSchema?: JsonResponseSchema;
  /** Requested output ceiling; clamped to `routeCeiling` and the root budget. */
  readonly maxOutputTokens: number;
  /** The hard output ceiling the route enforces. */
  readonly routeCeiling: number;
  /** Shared by every request made for the same task. */
  readonly budget: RootBudget;
  /** Caller cancellation. An abort resolves as `cancelled`, never as an error. */
  readonly signal?: AbortSignal;
  /** Overall deadline from send to last byte. */
  readonly timeoutMs: number;
  readonly onChunk?: (text: string) => void;
}

export type RequestOutcome<Route extends string = string> =
  | { kind: 'completed'; text: string; receipt: UsageReceipt<Route> }
  /** The provider stopped at the output ceiling; the text may be incomplete. */
  | { kind: 'truncated'; text: string; finishReason: string; receipt: UsageReceipt<Route> }
  | { kind: 'cancelled'; receipt: UsageReceipt<Route> }
  | { kind: 'timeout'; receipt: UsageReceipt<Route> }
  | { kind: 'error'; code: 'empty-output' | 'request-failed'; message: string; receipt: UsageReceipt<Route> }
  /** Nothing was sent: the task's root budget has no request or output left. */
  | { kind: 'refused'; reason: 'budget-exhausted' };

/** A request the core has just handed to its transport. */
export interface RequestStart<Route extends string = string> {
  /** The id the request's receipt will carry. */
  readonly id: string;
  readonly model: string;
  readonly route: Route;
  /** Epoch ms, the receipt's `startedAt`. */
  readonly startedAt: number;
  /** Abort this request; it resolves as `cancelled` with a receipt. */
  readonly cancel: () => void;
}

export interface RequestHooks<Route extends string> {
  /**
   * Called once when a request is dispatched to the transport, never for one
   * that was refused or cancelled before dispatch. Every announced request
   * later produces exactly one `onReceipt` with the same id, so a host can
   * show it as running (an activity list) and offer its `cancel`.
   */
  readonly onStart?: (request: RequestStart<Route>) => void;
  /** Called once per receipt, before the outcome resolves (e.g. a session receipt log). */
  readonly onReceipt?: (receipt: UsageReceipt<Route>) => void;
}

const TRUNCATION_REASONS = new Set(['length', 'max_tokens']);

let receiptSequence = 0;

interface Seen {
  streamed: boolean;
  finishReason: string | null;
  text: string | null;
  failure: Error | null;
  usage: TokenUsage | null;
}

export async function runModelRequest<Message, Route extends string>(
  request: ModelRequest<Message, Route>,
  hooks: RequestHooks<Route> = {},
): Promise<RequestOutcome<Route>> {
  const { budget, signal } = request;
  let startedAt = Date.now();
  let id = `req-${startedAt}-${++receiptSequence}`;
  let outputFormat: OutputFormat = 'text';
  const receiptFor = (outcome: UsageReceipt['outcome'], usage: TokenUsage | null): UsageReceipt<Route> => ({
    id, model: request.model, route: request.route, startedAt, finishedAt: Date.now(), outcome,
    ...(request.outputSchema ? { outputFormat } : {}),
    ...(usage ? { usageReported: true as const, ...usage } : { usageReported: false as const }),
  });
  // A caller that cancels before dispatch gets a typed outcome without a request, and no receipt is logged.
  if (signal?.aborted) return { kind: 'cancelled', receipt: receiptFor('cancelled', null) };
  const grant = reserveRequest(budget, Math.min(request.maxOutputTokens, request.routeCeiling));
  if (!grant) return { kind: 'refused', reason: 'budget-exhausted' };

  startedAt = Date.now();
  id = `req-${startedAt}-${receiptSequence}`;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const deadline = setTimeout(() => { timedOut = true; controller.abort(new Error('request-timeout')); }, request.timeoutMs);

  const seen: Seen = { streamed: false, finishReason: null, text: null, failure: null, usage: null };
  try {
    hooks.onStart?.({ id, model: request.model, route: request.route, startedAt, cancel: () => controller.abort() });
    if (!controller.signal.aborted) await request.transport({
      model: request.model,
      messages: request.messages,
      system: request.system,
      outputSchema: request.outputSchema,
      onOutputFormat: format => { outputFormat = format; },
      maxOutputTokens: grant.maxOutputTokens,
      signal: controller.signal,
      onChunk: text => { seen.streamed = true; request.onChunk?.(text); },
      onFinishReason: reason => { seen.finishReason = reason; },
      onComplete: text => { seen.text = text; },
      onError: error => { seen.failure ??= error; },
      onTokenUsage: reported => { seen.usage = reported; },
    });
  } catch (error) {
    seen.failure ??= error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abortFromCaller);
  }

  const { usage, failure, text, finishReason } = seen;
  settleRequest(budget, grant, usage ? usage.outputTokens : seen.streamed ? null : 0);
  const finish = (outcome: UsageReceipt['outcome']): UsageReceipt<Route> => {
    const receipt = receiptFor(outcome, usage);
    hooks.onReceipt?.(receipt);
    return receipt;
  };

  if (timedOut) return { kind: 'timeout', receipt: finish('timeout') };
  if (controller.signal.aborted) return { kind: 'cancelled', receipt: finish('cancelled') };
  if (failure) return { kind: 'error', code: 'request-failed', message: failure.message, receipt: finish('error') };
  if (text === null || !text.trim()) {
    return { kind: 'error', code: 'empty-output', message: 'empty-output', receipt: finish('error') };
  }
  if (finishReason && TRUNCATION_REASONS.has(finishReason)) {
    return { kind: 'truncated', text, finishReason, receipt: finish('truncated') };
  }
  return { kind: 'completed', text, receipt: finish('completed') };
}
