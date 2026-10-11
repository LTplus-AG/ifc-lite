/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One cancellable, time-limited streaming model request with a typed outcome.
 *
 * The lifecycle (deadline, cancellation, output-budget clamping against the
 * route ceiling and the task's root budget, the usage receipt) is the shared
 * `@ifc-lite/ai` core. This module supplies the viewer's transports (proxy,
 * Anthropic and OpenAI BYOK streams) and records each receipt in the
 * session's receipt log.
 */

import {
  runModelRequest as runSharedRequest, type AiTransport, type RequestOutcome as SharedOutcome, type RootBudget,
  type JsonResponseSchema,
} from '@ifc-lite/ai';
import type { StreamRoute } from './byok-guard.js';
import { modelCapabilities } from './model-capabilities.js';
import { recordReceipt, recordRequestStart } from './request-receipts.js';
import { streamChat, type StreamMessage, type StreamOptions, type UsageInfo } from './stream-client.js';
import { anthropicSchemaLimitation } from './anthropic-schema.js';

export type SendableRoute = Exclude<StreamRoute, { kind: 'missing-key' }>;

/**
 * Root budget helpers for hosts that pair them with `runModelRequest` (the
 * Flow AI service). Re-exported here so on-demand modules reach them through
 * this module rather than splitting the shared budget code into its own chunk.
 */
export { createRootBudget, restoreRootBudget } from '@ifc-lite/ai';

/** The hosted LLM proxy every proxy-routed request uses. */
export const LLM_PROXY_URL: string = import.meta.env.VITE_LLM_PROXY_URL || '/api/chat';

export interface ModelRequest {
  route: SendableRoute;
  proxyUrl: string;
  messages: StreamMessage[];
  system?: string;
  outputSchema?: JsonResponseSchema;
  /** Declared by the producer that owns the finalized prompt. */
  promptVersion?: string;
  /** Requested output ceiling; clamped to the route ceiling and the root budget. */
  maxOutputTokens: number;
  /** Shared by every request made for the same task. */
  budget: RootBudget;
  /** Caller cancellation. An abort resolves as `cancelled`, never as an error. */
  signal?: AbortSignal;
  /** Overall deadline from send to last byte. */
  timeoutMs: number;
  onChunk?: (text: string) => void;
  /** Hosted quota metadata, distinct from provider-reported token usage. */
  onUsageInfo?: (usage: UsageInfo) => void;
}

export type RequestOutcome = SharedOutcome<SendableRoute['kind']>;

type DirectStreams = typeof import('./stream-direct.js');

/**
 * The BYOK stream clients (and with them the Anthropic SDK) load on the first
 * direct request, not with the viewer: this module is reachable from the eager
 * bundle. Resolves `null` when `signal` aborts first, so a cancel or deadline
 * during the load settles at once instead of waiting for the chunk.
 */
function loadDirectStreams(signal: AbortSignal): Promise<DirectStreams | null> {
  if (signal.aborted) return Promise.resolve(null);
  let onAbort = () => {};
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([import('./stream-direct.js'), aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** The viewer's stream clients for one route, as a shared-core transport. */
function viewerTransport(route: SendableRoute, proxyUrl: string, onUsageInfo?: (usage: UsageInfo) => void): AiTransport<StreamMessage> {
  return async (call) => {
    const options: StreamOptions = { ...call, proxyUrl, messages: [...call.messages], onUsageInfo, allowProxyFallback: false, useParentDeadline: true };
    if (route.kind === 'proxy') { await streamChat(options); return; }
    // A failed load throws here and settles as the same `request-failed`
    // error as any other transport failure; an abort (caller or deadline)
    // during the load returns, and the core reports it as cancelled / timeout.
    const direct = await loadDirectStreams(call.signal);
    if (!direct || call.signal.aborted) return;
    if (route.kind === 'anthropic') await direct.streamAnthropicChat(route.credentials, options);
    else await direct.streamOpenAiChat(route.apiKey, options);
  };
}

export function runModelRequest(request: ModelRequest): Promise<RequestOutcome> {
  const { route } = request;
  if (route.kind === 'anthropic' && request.outputSchema && !request.signal?.aborted) {
    const message = anthropicSchemaLimitation(request.outputSchema);
    if (message) return Promise.resolve({ kind: 'refused', reason: 'unsupported-schema', message });
  }
  return runSharedRequest({
    model: route.model,
    route: route.kind,
    transport: viewerTransport(route, request.proxyUrl, request.onUsageInfo),
    prepareInput: () => JSON.stringify({ messages: request.messages, system: request.system, outputSchema: request.outputSchema }),
    messages: request.messages,
    system: request.system,
    outputSchema: request.outputSchema,
    promptVersion: request.promptVersion,
    maxOutputTokens: request.maxOutputTokens,
    routeCeiling: modelCapabilities(route.model).maxOutputTokens,
    budget: request.budget,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    onChunk: request.onChunk,
  }, { onStart: recordRequestStart, onReceipt: recordReceipt });
}
