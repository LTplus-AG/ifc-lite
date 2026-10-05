/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One cancellable, time-limited streaming model request with a typed outcome.
 *
 * The service owns the parts every caller otherwise re-implements: route
 * dispatch, the overall deadline, cancellation, output-budget clamping
 * against the model's route ceiling and the task's root budget, and a usage
 * receipt for every request that reached the network.
 */

import type { StreamRoute } from './byok-guard.js';
import { modelCapabilities } from './model-capabilities.js';
import { recordReceipt, recordRequestStart, type UsageReceipt } from './request-receipts.js';
import { reserveRequest, settleRequest, type RootBudget } from './root-budget.js';
import { streamChat, type StreamMessage, type StreamOptions } from './stream-client.js';
import { streamAnthropicChat, streamOpenAiChat } from './stream-direct.js';
import type { TokenUsage } from './token-usage.js';

export type SendableRoute = Exclude<StreamRoute, { kind: 'missing-key' }>;

export interface ModelRequest {
  route: SendableRoute;
  proxyUrl: string;
  messages: StreamMessage[];
  system?: string;
  /** Requested output ceiling; clamped to the route ceiling and the root budget. */
  maxOutputTokens: number;
  /** Shared by every request made for the same task. */
  budget: RootBudget;
  /** Caller cancellation. An abort resolves as `cancelled`, never as an error. */
  signal?: AbortSignal;
  /** Overall deadline from send to last byte. */
  timeoutMs: number;
  onChunk?: (text: string) => void;
}

export type RequestOutcome =
  | { kind: 'completed'; text: string; receipt: UsageReceipt }
  /** The provider stopped at the output ceiling; the text may be incomplete. */
  | { kind: 'truncated'; text: string; finishReason: string; receipt: UsageReceipt }
  | { kind: 'cancelled'; receipt: UsageReceipt }
  | { kind: 'timeout'; receipt: UsageReceipt }
  | { kind: 'error'; code: 'empty-output' | 'request-failed'; message: string; receipt: UsageReceipt }
  /** Nothing was sent: the task's root budget has no request or output left. */
  | { kind: 'refused'; reason: 'budget-exhausted' };

const TRUNCATION_REASONS = new Set(['length', 'max_tokens']);

let receiptSequence = 0;

interface StreamResult {
  streamed: boolean;
  finishReason: string | null;
  text: string | null;
  failure: Error | null;
  usage: TokenUsage | null;
}

export async function runModelRequest(request: ModelRequest): Promise<RequestOutcome> {
  const { route, budget, signal } = request;
  if (signal?.aborted) return cancelledWithoutRequest(request);
  const ceiling = Math.min(request.maxOutputTokens, modelCapabilities(route.model).maxOutputTokens);
  const grant = reserveRequest(budget, ceiling);
  if (!grant) return { kind: 'refused', reason: 'budget-exhausted' };

  const startedAt = Date.now();
  const id = `req-${startedAt}-${++receiptSequence}`;
  const controller = new AbortController();
  recordRequestStart({ id, model: route.model, startedAt, cancel: () => controller.abort(new DOMException('Cancelled', 'AbortError')) });
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const deadline = setTimeout(() => { timedOut = true; controller.abort(new Error('request-timeout')); }, request.timeoutMs);

  const seen: StreamResult = { streamed: false, finishReason: null, text: null, failure: null, usage: null };
  const options: StreamOptions = {
    proxyUrl: request.proxyUrl,
    model: route.model,
    messages: request.messages,
    system: request.system,
    maxOutputTokens: grant.maxOutputTokens,
    signal: controller.signal,
    onChunk: text => { seen.streamed = true; request.onChunk?.(text); },
    onFinishReason: reason => { seen.finishReason = reason; },
    onComplete: text => { seen.text = text; },
    onError: error => { seen.failure ??= error; },
    onTokenUsage: reported => { seen.usage = reported; },
  };
  try {
    if (route.kind === 'proxy') await streamChat(options);
    else if (route.kind === 'anthropic') await streamAnthropicChat(route.credentials, options);
    else await streamOpenAiChat(route.apiKey, options);
  } catch (error) {
    seen.failure ??= error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abortFromCaller);
  }

  const { usage: reported, failure: error, text, finishReason: reason } = seen;
  settleRequest(budget, grant, reported ? reported.outputTokens : seen.streamed ? null : 0);
  const receiptFor = (outcome: UsageReceipt['outcome']): UsageReceipt => {
    const receipt: UsageReceipt = {
      id, model: route.model, route: route.kind,
      startedAt, finishedAt: Date.now(), outcome,
      ...(reported ? { usageReported: true as const, ...reported } : { usageReported: false as const }),
    };
    recordReceipt(receipt);
    return receipt;
  };

  if (timedOut) return { kind: 'timeout', receipt: receiptFor('timeout') };
  if (controller.signal.aborted) return { kind: 'cancelled', receipt: receiptFor('cancelled') };
  if (error) return { kind: 'error', code: 'request-failed', message: error.message, receipt: receiptFor('error') };
  if (text === null || !text.trim()) {
    return { kind: 'error', code: 'empty-output', message: 'empty-output', receipt: receiptFor('error') };
  }
  if (reason && TRUNCATION_REASONS.has(reason)) {
    return { kind: 'truncated', text, finishReason: reason, receipt: receiptFor('truncated') };
  }
  return { kind: 'completed', text, receipt: receiptFor('completed') };
}

/** A caller that cancels before dispatch gets a typed outcome without a network request. */
function cancelledWithoutRequest(request: ModelRequest): RequestOutcome {
  const now = Date.now();
  return { kind: 'cancelled', receipt: { id: `req-${now}-${++receiptSequence}`, model: request.route.model,
    route: request.route.kind, startedAt: now, finishedAt: now, outcome: 'cancelled', usageReported: false } };
}
