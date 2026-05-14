/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stream a chat completion from an in-browser WebLLM model.
 *
 * The engine is OpenAI-shape (`engine.chat.completions.create`), so this
 * file mirrors {@link streamOpenAiChatCompletions} but skips the network
 * fetch — inference runs entirely on the user's machine via WebGPU.
 *
 * Multimodal content is flattened to text for v1 — the default models
 * (Qwen2.5-Coder, Llama-3.2) don't accept images, and the chat panel
 * already gates image attachments on the model's `supportsImages` flag.
 */

import type { ChatCompletionMessageParam } from '@mlc-ai/web-llm';
import type { StreamMessage, StreamOptions } from './stream-client.js';
import { ensureWebLLMEngine } from './webllm-engine.js';
import { hasWebLLMConsent } from './webllm-consent.js';
import { getModelById } from './models.js';

export class WebLLMConsentRequiredError extends Error {
  readonly code = 'webllm-consent-required';
  constructor(public readonly modelId: string) {
    super(`Local model "${modelId}" needs to be downloaded before first use.`);
  }
}

/** Tokens we reserve for the model's reply. */
const OUTPUT_BUDGET_TOKENS = 1024;

/**
 * Coarse estimator — averaging across English code+prose, BPE tokens land
 * around 3.5–4 characters each. Slight overestimate on the safe side.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

function messageTokens(m: { content: string }): number {
  // +4 covers role markers / chat-template overhead per message.
  return estimateTokens(m.content) + 4;
}

interface TrimmedConversation {
  system: string | null;
  messages: StreamMessage[];
  systemTokens: number;
  totalTokens: number;
  truncated: boolean;
}

/**
 * Drop oldest non-system turns until the conversation fits within
 * `contextWindow - OUTPUT_BUDGET_TOKENS`. The newest user message and the
 * system prompt are kept verbatim — if even those two don't fit, we surface
 * the error to the caller.
 */
function trimToContextWindow(
  messages: StreamMessage[],
  system: string | undefined,
  contextWindow: number,
): TrimmedConversation {
  const budget = Math.max(256, contextWindow - OUTPUT_BUDGET_TOKENS);
  const systemContent = system ?? null;
  const systemTokens = systemContent ? estimateTokens(systemContent) + 4 : 0;

  // Flatten content first so token estimates match what's actually sent.
  const flattened = messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? m.content
      : m.content.map((p) => p.type === 'text' ? p.text : '').join('\n'),
  }));

  // Find the index of the most-recent user message — it must survive trimming.
  const lastUserIdx = (() => {
    for (let i = flattened.length - 1; i >= 0; i--) {
      if (flattened[i].role === 'user') return i;
    }
    return flattened.length - 1;
  })();

  const kept: Array<typeof flattened[number]> = [flattened[lastUserIdx]];
  let runningTokens = systemTokens + messageTokens(kept[0]);

  // Walk backwards from just before lastUserIdx, adding history while budget allows.
  for (let i = lastUserIdx - 1; i >= 0; i--) {
    const candidate = flattened[i];
    const cost = messageTokens(candidate);
    if (runningTokens + cost > budget) break;
    kept.unshift(candidate);
    runningTokens += cost;
  }

  // Re-cast kept entries to StreamMessage shape (content stays as string).
  const trimmedMessages: StreamMessage[] = kept.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  return {
    system: systemContent,
    messages: trimmedMessages,
    systemTokens,
    totalTokens: runningTokens,
    truncated: trimmedMessages.length < messages.length,
  };
}

function flattenContent(content: StreamMessage['content']): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push(part.text);
    } else {
      parts.push(`[Image attachment skipped — current local model does not accept images]`);
    }
  }
  return parts.join('\n');
}

function toWebLLMMessages(messages: StreamMessage[], system?: string): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    const content = flattenContent(m.content);
    if (m.role === 'user') {
      out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content });
    } else {
      out.push({ role: 'system', content });
    }
  }
  return out;
}

export async function streamWebLLMChat(
  options: Omit<StreamOptions, 'proxyUrl' | 'authToken' | 'onUsageInfo'>,
): Promise<void> {
  const { model, messages, system, signal, onChunk, onComplete, onError, onFinishReason } = options;

  if (!hasWebLLMConsent(model)) {
    onError(new WebLLMConsentRequiredError(model));
    return;
  }

  // Trim history to fit the local model's compiled context window. Smaller
  // MLC builds (e.g. Qwen2.5-Coder-1.5B at 4096) overflow easily on the
  // viewer's full IFC system prompt — we shed older turns rather than crash.
  const modelDef = getModelById(model);
  const contextWindow = modelDef?.contextWindow ?? 4096;
  const trimmed = trimToContextWindow(messages, system, contextWindow);
  if (trimmed.totalTokens > contextWindow - OUTPUT_BUDGET_TOKENS) {
    onError(new Error(
      `Local model "${modelDef?.name ?? model}" has a ${contextWindow.toLocaleString()}-token context window. ` +
      `Your current message plus the system prompt is too large (≈${trimmed.totalTokens.toLocaleString()} tokens). ` +
      `Pick the Qwen 7B model (32K context) or shorten your message.`,
    ));
    return;
  }

  let engine;
  try {
    engine = await ensureWebLLMEngine(model);
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (signal?.aborted) return;

  let fullText = '';
  let finishReason: string | null = null;

  try {
    const stream = await engine.chat.completions.create({
      messages: toWebLLMMessages(trimmed.messages, trimmed.system ?? undefined),
      stream: true,
      temperature: 0.3,
      max_tokens: OUTPUT_BUDGET_TOKENS,
    });

    for await (const chunk of stream) {
      if (signal?.aborted) {
        try { await engine.interruptGenerate(); } catch { /* ignore */ }
        return;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        fullText += delta;
        onChunk(delta);
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
  } catch (err) {
    if (signal?.aborted) return;
    onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (signal?.aborted) return;
  onFinishReason?.(finishReason);
  onComplete(fullText);
}
