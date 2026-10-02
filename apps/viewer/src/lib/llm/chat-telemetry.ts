/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scrub-safe telemetry for one AI chat turn: `ai_chat_message_sent` when the
 * request leaves, `ai_chat_response_completed` when it settles.
 *
 * Fixed enums and numbers only. Never the prompt, the response, an attachment,
 * a provider error text or a model id outside the registry. Key names are
 * chosen around `analytics-scrub.ts`'s SENSITIVE_KEY rule, which deletes any
 * key with a `_`-delimited `model` or `message` word: the old capture sent
 * `model` and `message_count`, so every `ai_chat_message_sent` arrived with no
 * properties at all.
 */

import { posthog } from '../analytics.js';
import { getModelById } from './models.js';

/** Which way the request went: the hosted proxy, or the user's own key. */
export type ChatRouteKind = 'proxy' | 'anthropic' | 'openai';
export type ChatProviderKind = 'built_in' | 'byok';
export type ChatOutcome = 'success' | 'error' | 'aborted';
export type ChatErrorClass =
  | 'auth' | 'rate_limit' | 'timeout' | 'network' | 'provider' | 'http' | 'other';
export type ChatTurnKind = 'chat' | 'repair' | 'continue';

const LLM_FAMILIES = [
  ['claude', /^(?:anthropic\/)?claude/i],
  ['gpt', /^(?:openai\/)?(?:gpt|chatgpt|o\d)/i],
  ['gemini', /^(?:google\/)?gemini|^google\/gemma/i],
  ['llama', /llama/i],
  ['mistral', /mistral|mixtral|codestral|devstral/i],
  ['qwen', /qwen/i],
  ['deepseek', /deepseek/i],
  ['grok', /grok/i],
] as const;
export type LlmFamily = (typeof LLM_FAMILIES)[number][0] | 'other' | 'unregistered';

/**
 * Family of a model id, from the registry only. An id the registry does not
 * list (a stale stored selection, a hand-edited setting) is `unregistered`,
 * never echoed, so free text cannot ride in through the model picker.
 */
export function llmFamily(modelId: string): LlmFamily {
  const model = getModelById(modelId);
  if (!model) return 'unregistered';
  for (const [family, pattern] of LLM_FAMILIES) if (pattern.test(model.id)) return family;
  return 'other';
}

/** Coarse class of a failed turn, read off our own error wordings; the text is never sent. */
export function chatErrorClass(err: Error): ChatErrorClass {
  const text = err.message;
  if (/authentication|unauthori[sz]ed|invalid api key|\b401\b|\b403\b/i.test(text)) return 'auth';
  if (/limit reached|rate limit|too many requests|\b429\b|quota/i.test(text)) return 'rate_limit';
  if (/timed out|timeout/i.test(text)) return 'timeout';
  if (/failed to fetch|networkerror|network error|load failed|no response body/i.test(text)) return 'network';
  if (/provider/i.test(text)) return 'provider';
  if (/\bHTTP \d{3}\b|request failed \(\d{3}\)/i.test(text)) return 'http';
  return 'other';
}

export interface ChatTurnStart {
  route: ChatRouteKind;
  modelId: string;
  /** Messages in the request, history included. */
  turnCount: number;
  kind: ChatTurnKind;
  attachmentCount: number;
}

export interface ChatTurnTelemetry {
  /** First streamed text: records time to first token. */
  noteFirstChunk(): void;
  noteFinishReason(reason: string | null): void;
  /** Settle the turn. Only the first call is recorded. */
  finish(outcome: ChatOutcome, details?: { error?: Error; scriptEdited?: boolean }): void;
}

export interface ChatTelemetryDeps {
  now: () => number;
  capture: (event: string, properties: Record<string, unknown>) => void;
}

const defaultDeps: ChatTelemetryDeps = {
  now: () => performance.now(),
  capture: (event, properties) => posthog.capture(event, properties),
};

function finishReasonBucket(reason: string | null | undefined): 'stop' | 'length' | 'other' | 'none' {
  if (!reason) return 'none';
  if (reason === 'stop' || reason === 'end_turn' || reason === 'completed') return 'stop';
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens') return 'length';
  return 'other';
}

/** Capture `ai_chat_message_sent` now and return the handle that settles the turn. */
export function startChatTurnTelemetry(start: ChatTurnStart, deps: ChatTelemetryDeps = defaultDeps): ChatTurnTelemetry {
  const base = {
    provider_kind: (start.route === 'proxy' ? 'built_in' : 'byok') as ChatProviderKind,
    provider: start.route,
    llm_family: llmFamily(start.modelId),
    turn_kind: start.kind,
  };
  deps.capture('ai_chat_message_sent', {
    ...base,
    turn_count: start.turnCount,
    attachment_count: start.attachmentCount,
  });
  const startedAt = deps.now();
  let firstChunkMs: number | null = null;
  let finishReason: string | null = null;
  let settled = false;
  return {
    noteFirstChunk() {
      if (firstChunkMs === null) firstChunkMs = Math.round(deps.now() - startedAt);
    },
    noteFinishReason(reason) {
      finishReason = reason;
    },
    finish(outcome, details) {
      if (settled) return;
      settled = true;
      const props: Record<string, unknown> = {
        ...base,
        outcome,
        latency_ms: Math.round(deps.now() - startedAt),
        finish_reason: finishReasonBucket(finishReason),
        script_edited: details?.scriptEdited === true,
      };
      if (firstChunkMs !== null) props.first_chunk_ms = firstChunkMs;
      if (outcome === 'error' && details?.error) props.error_class = chatErrorClass(details.error);
      deps.capture('ai_chat_response_completed', props);
    },
  };
}
