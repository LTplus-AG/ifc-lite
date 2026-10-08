/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Provider-reported token usage, read from the frames each protocol actually
 * streams. A parser returns null when the frame carries no complete count;
 * callers then record "usage not reported" rather than inventing a number.
 */

export interface TokenUsage {
  /** Prompt tokens the provider billed, cached prompt tokens included. */
  inputTokens: number;
  /** Completion tokens the provider billed, reasoning tokens included. */
  outputTokens: number;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * OpenAI Chat Completions / OpenRouter: a chunk carrying
 * `usage: { prompt_tokens, completion_tokens }` (OpenAI sends it as the last
 * chunk, with `choices: []`, when `stream_options.include_usage` is set).
 */
export function chatCompletionsUsage(chunk: unknown): TokenUsage | null {
  const usage = record(record(chunk)?.usage);
  const inputTokens = count(usage?.prompt_tokens);
  const outputTokens = count(usage?.completion_tokens);
  return inputTokens === null || outputTokens === null ? null : { inputTokens, outputTokens };
}

/** OpenAI Responses: `response.completed` / `response.incomplete` carry `response.usage`. */
export function responsesUsage(event: unknown): TokenUsage | null {
  const usage = record(record(record(event)?.response)?.usage);
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  return inputTokens === null || outputTokens === null ? null : { inputTokens, outputTokens };
}

/**
 * Anthropic Messages: the accumulated `usage` of the final message
 * (`message_start.message.usage`, updated by `message_delta.usage`).
 * `input_tokens` excludes cache reads and writes, so they are added back to
 * keep `inputTokens` comparable with the OpenAI-style total.
 */
export function anthropicUsage(usage: unknown): TokenUsage | null {
  const u = record(usage);
  const input = count(u?.input_tokens);
  const outputTokens = count(u?.output_tokens);
  if (input === null || outputTokens === null) return null;
  const cacheWrite = count(u?.cache_creation_input_tokens) ?? 0;
  const cacheRead = count(u?.cache_read_input_tokens) ?? 0;
  return { inputTokens: input + cacheWrite + cacheRead, outputTokens };
}
