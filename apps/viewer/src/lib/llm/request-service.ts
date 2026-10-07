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
} from '@ifc-lite/ai';
import type { StreamRoute } from './byok-guard.js';
import { modelCapabilities } from './model-capabilities.js';
import { recordReceipt } from './request-receipts.js';
import { streamChat, type StreamMessage, type StreamOptions } from './stream-client.js';
import { streamAnthropicChat, streamOpenAiChat } from './stream-direct.js';

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

export type RequestOutcome = SharedOutcome<SendableRoute['kind']>;

/** The viewer's stream clients for one route, as a shared-core transport. */
function viewerTransport(route: SendableRoute, proxyUrl: string): AiTransport<StreamMessage> {
  return async (call) => {
    const options: StreamOptions = { ...call, proxyUrl, messages: [...call.messages] };
    if (route.kind === 'proxy') await streamChat(options);
    else if (route.kind === 'anthropic') await streamAnthropicChat(route.credentials, options);
    else await streamOpenAiChat(route.apiKey, options);
  };
}

export function runModelRequest(request: ModelRequest): Promise<RequestOutcome> {
  const { route } = request;
  return runSharedRequest({
    model: route.model,
    route: route.kind,
    transport: viewerTransport(route, request.proxyUrl),
    messages: request.messages,
    system: request.system,
    maxOutputTokens: request.maxOutputTokens,
    routeCeiling: modelCapabilities(route.model).maxOutputTokens,
    budget: request.budget,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    onChunk: request.onChunk,
  }, { onReceipt: recordReceipt });
}
