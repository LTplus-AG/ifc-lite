/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * OpenAI-compatible Chat Completions adapter for the tool-turn contract
 * (provider two, `06-ai-agent.md` §3: offered for a mode only where it
 * passes that mode's eval gate). One non-streaming request per turn through
 * the host's `fetch`; the host supplies the key and base URL.
 *
 * Tool inputs arrive as JSON text; one that does not parse is passed on as
 * `rawInput` so the registry answers `INVALID_JSON` instead of running it.
 * `strict` is not sent: OpenAI strict mode requires every property to be
 * required, which optional tool fields are not. The registry validates.
 */

import { chatCompletionsUsage, type ContentBlock, type ToolTurn, type ToolTurnCall, type ToolTurnMessage, type ToolTurnStopReason, type ToolTurnTransport } from '@ifc-lite/ai';

export interface OpenAiAdapterConfig {
  readonly apiKey: string;
  /** Default `https://api.openai.com/v1`. */
  readonly baseUrl?: string;
  /** Send `reasoning_effort` (reasoning models only). Default false. */
  readonly reasoningEffort?: boolean;
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toChatMessages(call: Pick<ToolTurnCall, 'system' | 'context' | 'messages'>): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: call.system }];
  call.messages.forEach((m: ToolTurnMessage, i) => {
    if (m.role === 'user') {
      out.push({ role: 'user', content: i === 0 && call.context ? `${call.context}\n\n${m.content}` : m.content });
    } else if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('');
      const calls = m.content.flatMap((b) => (b.type === 'tool_call'
        ? [{ id: b.id, type: 'function' as const, function: { name: b.name, arguments: b.rawInput ?? JSON.stringify(b.input ?? {}) } }]
        : []));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.callId, content: r.content });
    }
  });
  return out;
}

const STOP: Readonly<Record<string, ToolTurnStopReason>> = {
  stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', content_filter: 'refusal',
};

interface ChatResponse {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] };
  }[];
}

export function fromChatResponse(body: ChatResponse): ToolTurn {
  const choice = body.choices?.[0];
  const content: ContentBlock[] = [];
  const text = choice?.message?.content;
  if (typeof text === 'string' && text) content.push({ type: 'text', text });
  for (const [i, tc] of (choice?.message?.tool_calls ?? []).entries()) {
    const raw = tc.function?.arguments ?? '';
    let input: unknown;
    let parsed = true;
    try {
      input = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = false; // reported to the model as INVALID_JSON by the registry
    }
    content.push({ type: 'tool_call', id: tc.id ?? `call-${i}`, name: tc.function?.name ?? '', input, ...(parsed ? {} : { rawInput: raw }) });
  }
  const refusal = choice?.message?.refusal;
  const finish = choice?.finish_reason ?? '';
  return {
    content,
    stopReason: refusal ? 'refusal' : STOP[finish] ?? 'other',
    usage: chatCompletionsUsage(body),
    ...(body.model ? { servedModel: body.model } : {}),
    ...(refusal ? { refusal: { category: null, explanation: refusal } } : {}),
  };
}

export function openAiTransport(config: OpenAiAdapterConfig, fetchImpl: typeof fetch = fetch): ToolTurnTransport {
  const baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  return async (call) => {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: call.model,
        max_completion_tokens: call.maxOutputTokens,
        messages: toChatMessages(call),
        tools: call.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
        tool_choice: 'auto',
        ...(config.reasoningEffort && call.effort ? { reasoning_effort: call.effort === 'xhigh' || call.effort === 'max' ? 'high' : call.effort } : {}),
      }),
      signal: call.signal,
    });
    if (!response.ok) throw new Error(`the AI provider answered HTTP ${response.status}`);
    const turn = fromChatResponse(await response.json() as ChatResponse);
    for (const b of turn.content) if (b.type === 'text') call.onText(b.text);
    return turn;
  };
}
