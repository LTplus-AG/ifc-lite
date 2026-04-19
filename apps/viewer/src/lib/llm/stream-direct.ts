/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Direct browser-to-provider streaming for BYOK (Bring Your Own Key) models.
 *
 * Anthropic: Uses the official @anthropic-ai/sdk with `dangerouslyAllowBrowser`.
 * OpenAI:    Uses fetch against the OpenAI chat completions API (same SSE format
 *            the proxy already returns, so SSE parsing is shared).
 *
 * Keys are stored in localStorage and sent directly to the provider.
 * They never pass through our server.
 */

import Anthropic from '@anthropic-ai/sdk';
import { drainSseBuffer, type StreamMessage, type StreamOptions } from './stream-client.js';

const STREAM_REQUEST_TIMEOUT_MS = 45_000;

// ── Anthropic ──────────────────────────────────────────────────────────────

type AnthropicMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: AnthropicMediaType; data: string } };

function toAnthropicMessages(
  messages: StreamMessage[],
): Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }> {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      if (typeof m.content === 'string') {
        return { role: m.role as 'user' | 'assistant', content: m.content };
      }
      // Multimodal content — convert OpenAI-style parts to Anthropic format
      const blocks: AnthropicContentBlock[] = m.content.map((part) => {
        if (part.type === 'text') {
          return { type: 'text' as const, text: part.text };
        }
        // image_url → Anthropic image block
        const dataUrl = part.image_url.url;
        const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: match[1] as AnthropicMediaType,
              data: match[2],
            },
          };
        }
        // Fallback: pass URL as text
        return { type: 'text' as const, text: `[Image: ${dataUrl.slice(0, 100)}]` };
      });
      return { role: m.role as 'user' | 'assistant', content: blocks };
    });
}

export async function streamAnthropicChat(
  apiKey: string,
  options: Omit<StreamOptions, 'proxyUrl' | 'authToken' | 'onUsageInfo'>,
): Promise<void> {
  const { model, messages, system, signal, onChunk, onComplete, onError, onFinishReason } = options;

  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
  });

  let fullText = '';
  try {
    const stream = client.messages.stream({
      model,
      max_tokens: 8192,
      temperature: 0.3,
      system: system || undefined,
      messages: toAnthropicMessages(messages),
    });

    // Wire up abort signal
    if (signal) {
      const onAbort = () => stream.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      stream.on('end', () => signal.removeEventListener('abort', onAbort));
    }

    stream.on('text', (text) => {
      fullText += text;
      onChunk(text);
    });

    const finalMessage = await stream.finalMessage();

    if (signal?.aborted) return;

    const stopReason = finalMessage.stop_reason;
    onFinishReason?.(stopReason === 'end_turn' ? 'stop' : stopReason);
    onComplete(fullText);
  } catch (err) {
    if (signal?.aborted) return;

    if (err instanceof Anthropic.APIError) {
      const msg = err.status === 401
        ? 'Invalid Anthropic API key. Check your key in Settings.'
        : err.status === 429
          ? 'Anthropic rate limit reached. Please wait and try again.'
          : `Anthropic error (${err.status}): ${err.message}`;
      onError(new Error(msg));
    } else {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

// ── OpenAI ─────────────────────────────────────────────────────────────────

import { getModelById } from './models.js';

/**
 * Stream an OpenAI model. Automatically picks the right API:
 * - Chat Completions (`/v1/chat/completions`) for standard chat models
 * - Responses (`/v1/responses`) for Codex-style models
 */
export async function streamOpenAiChat(
  apiKey: string,
  options: Omit<StreamOptions, 'proxyUrl' | 'authToken' | 'onUsageInfo'>,
): Promise<void> {
  const modelDef = getModelById(options.model);
  if (modelDef?.openaiApi === 'responses') {
    return streamOpenAiResponses(apiKey, options);
  }
  return streamOpenAiChatCompletions(apiKey, options);
}

/** Standard Chat Completions API (GPT-5.4, GPT-5.4 Mini, etc.) */
async function streamOpenAiChatCompletions(
  apiKey: string,
  options: Omit<StreamOptions, 'proxyUrl' | 'authToken' | 'onUsageInfo'>,
): Promise<void> {
  const { model, messages, system, signal, onChunk, onComplete, onError, onFinishReason } = options;

  const allMessages: StreamMessage[] = system
    ? [{ role: 'system', content: system }, ...messages]
    : [...messages];

  const { response, cleanup } = await openAiFetch(
    'https://api.openai.com/v1/chat/completions',
    {
      model,
      messages: allMessages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      temperature: 0.3,
      max_completion_tokens: 8192,
    },
    apiKey,
    signal,
    onError,
  );
  if (!response) return;

  if (!response.body) { cleanup(); onError(new Error('No response body')); return; }

  let fullText = '';
  let finishReason: string | null = null;

  const ok = await readSseStream(response.body, signal, (data) => {
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
    };
    const content = parsed.choices?.[0]?.delta?.content;
    if (content) { fullText += content; onChunk(content); }
    const fr = parsed.choices?.[0]?.finish_reason;
    if (fr) finishReason = fr;
  }, onError);

  cleanup();
  if (ok) { onFinishReason?.(finishReason); onComplete(fullText); }
}

/** Responses API for Codex-style models (GPT-5.3 Codex) */
async function streamOpenAiResponses(
  apiKey: string,
  options: Omit<StreamOptions, 'proxyUrl' | 'authToken' | 'onUsageInfo'>,
): Promise<void> {
  const { model, messages, system, signal, onChunk, onComplete, onError, onFinishReason } = options;

  // Build the input array: system instructions + conversation
  const input: Array<{ role: string; content: string | unknown[] }> = [];
  if (system) {
    input.push({ role: 'developer', content: system });
  }
  for (const m of messages) {
    input.push({ role: m.role, content: m.content });
  }

  const { response, cleanup } = await openAiFetch(
    'https://api.openai.com/v1/responses',
    {
      model,
      input,
      stream: true,
      max_output_tokens: 8192,
    },
    apiKey,
    signal,
    onError,
  );
  if (!response) return;

  if (!response.body) { cleanup(); onError(new Error('No response body')); return; }

  let fullText = '';

  const ok = await readSseStream(response.body, signal, (data) => {
    const event = JSON.parse(data) as {
      type?: string;
      delta?: string;
      response?: { status?: string };
    };
    if (event.type === 'response.output_text.delta' && event.delta) {
      fullText += event.delta;
      onChunk(event.delta);
    }
  }, onError);

  cleanup();
  if (ok) { onFinishReason?.('stop'); onComplete(fullText); }
}

// ── Shared helpers ─────────────────────────────────────────────────────────

async function openAiFetch(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal | undefined,
  onError: (err: Error) => void,
): Promise<{ response: Response | null; cleanup: () => void }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error('Chat request timed out. Please try again.')),
    STREAM_REQUEST_TIMEOUT_MS,
  );
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) { clearTimeout(timeoutId); return { response: null, cleanup: () => {} }; }
    signal.addEventListener('abort', abortFromParent, { once: true });
  }

  // cleanup() clears the connect timeout and removes the abort listener.
  // Callers must call it AFTER streaming completes, not before — otherwise
  // user cancellation during SSE consumption won't abort the fetch.
  const cleanup = () => {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromParent);
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    cleanup();
    if (signal?.aborted) return { response: null, cleanup: () => {} };
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      onError(controller.signal.reason);
    } else {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
    return { response: null, cleanup: () => {} };
  }

  if (!response.ok) {
    cleanup();
    let detail = `OpenAI error (${response.status})`;
    try {
      const errBody = (await response.json()) as { error?: { message?: string } };
      if (response.status === 401) {
        detail = 'Invalid OpenAI API key. Check your key in the chat panel.';
      } else if (response.status === 429) {
        detail = 'OpenAI rate limit reached. Please wait and try again.';
      } else if (errBody.error?.message) {
        detail = `OpenAI: ${errBody.error.message}`;
      }
    } catch { /* ignore parse failure */ }
    onError(new Error(detail));
    return { response: null, cleanup: () => {} };
  }

  return { response, cleanup };
}

/** Read an SSE stream, calling onEvent for each `data:` line. Returns true if completed normally. */
async function readSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onEvent: (data: string) => void,
  onError: (err: Error) => void,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const drained = drainSseBuffer(buffer);
      buffer = drained.remainder;
      for (const evt of drained.events) {
        for (const line of evt.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try { onEvent(data); } catch { /* skip malformed */ }
        }
      }
    }
    buffer += decoder.decode();
    const drained = drainSseBuffer(buffer, true);
    for (const evt of drained.events) {
      for (const line of evt.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try { onEvent(data); } catch { /* skip malformed */ }
      }
    }
    return true;
  } catch (err) {
    if (signal?.aborted) return false;
    onError(err instanceof Error ? err : new Error(String(err)));
    return false;
  }
}
