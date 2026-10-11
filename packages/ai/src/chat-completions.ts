/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The shared opt-in OpenAI-compatible transport for CLI and MCP Flow hosts (#7070). */
import { chatCompletionsUsage } from './usage.js';
import type { AiTransport } from './request.js';

export interface FlowAiConfig {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Explicit opt-in for an OpenAI-compatible upstream known to accept JSON Schema. */
  readonly structuredOutput?: boolean;
}

export function flowAiConfig(env: Readonly<Record<string, string | undefined>>): FlowAiConfig | null {
  const model = env.IFC_LITE_AI_MODEL?.trim();
  const apiKey = env.IFC_LITE_AI_API_KEY?.trim();
  if (!model || !apiKey) return null;
  const baseUrl = (env.IFC_LITE_AI_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const configured = env.IFC_LITE_AI_STRUCTURED_OUTPUT?.trim();
  if (configured && configured !== 'true' && configured !== 'false') throw new Error('IFC_LITE_AI_STRUCTURED_OUTPUT must be true or false');
  return { model, apiKey, baseUrl,
    structuredOutput: configured ? configured === 'true' : baseUrl === 'https://api.openai.com/v1' };
}

/** One non-streaming OpenAI-compatible chat completion, reported through the core's callbacks. */
export function chatCompletionsTransport(config: FlowAiConfig, fetchImpl: typeof fetch = fetch): AiTransport<string> {
  return async (call) => {
    const outputSchema = config.structuredOutput ? call.outputSchema : undefined;
    call.onOutputFormat?.(outputSchema ? 'json-schema' : 'text');
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: call.model,
        max_tokens: call.maxOutputTokens,
        ...(outputSchema ? { response_format: { type: 'json_schema', json_schema: { ...outputSchema, strict: true } } } : {}),
        messages: [...(call.system ? [{ role: 'system', content: call.system }] : []), ...call.messages.map((content) => ({ role: 'user', content }))],
      }),
      signal: call.signal,
    });
    if (!response.ok) throw new Error(`the AI provider answered HTTP ${response.status}`);
    const body = await response.json() as { choices?: { message?: { content?: unknown }; finish_reason?: string | null }[] };
    const usage = chatCompletionsUsage(body);
    if (usage) call.onTokenUsage(usage);
    const choice = body.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (text) call.onChunk(text);
    call.onFinishReason(choice?.finish_reason ?? null);
    call.onComplete(text);
  };
}
