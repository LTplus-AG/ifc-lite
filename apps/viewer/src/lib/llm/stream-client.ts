/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Streaming client for the LLM chat proxy.
 *
 * Sends chat messages to the Edge proxy and streams the response
 * back as SSE. Extracts usage headers from the response for UI display.
 */

import { outputTokenLimit, PROXY_OUTPUT_TOKEN_CEILING } from '../../../../../shared/ai/output-budget.js';
import { readSseStream } from './sse-reader.js';
export { drainSseBuffer, readSseStream } from './sse-reader.js';
import { buildCacheableSystem, logCacheHit } from './prompt-cache.js';
import { chatCompletionsUsage, type TokenUsage } from '@ifc-lite/ai';
import { parseUsageFromHeaders } from './usage-quota.js';
/** A text content part in a multimodal message */
export interface TextContentPart {
  type: 'text';
  text: string;
}

/** An image content part in a multimodal message */
export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string };
}

export type MessageContent = string | Array<TextContentPart | ImageContentPart>;

export interface StreamMessage {
  role: 'user' | 'assistant' | 'system';
  content: MessageContent;
}

/** Usage info extracted from proxy response headers */
export interface UsageInfo {
  /** 'credits' for pro, 'requests' for free */
  type: 'credits' | 'requests';
  /** Amount used: credits consumed (pro) or request count (free) */
  used: number;
  /** Limit: credit allowance (pro) or request cap (free) */
  limit: number;
  /** Percentage used (0-100) */
  pct: number;
  /** Reset time (epoch seconds) */
  resetAt: number;
  /** Whether this request can consume credits (pro paid model) */
  billable?: boolean;
}

export interface StreamOptions {
  /** Proxy URL (Edge Function) */
  proxyUrl: string;
  /** Model ID */
  model: string;
  /** Conversation messages */
  messages: StreamMessage[];
  /** System prompt */
  system?: string;
  /** Positive output token ceiling, including reasoning; does not guarantee visible text. */
  maxOutputTokens?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Called for each text chunk as it arrives */
  onChunk: (text: string) => void;
  /** Called when the stream completes */
  onComplete: (fullText: string) => void;
  /** Called with the model/provider finish reason when available */
  onFinishReason?: (finishReason: string | null) => void;
  /** Called on error */
  onError: (error: Error) => void;
  /** Called with usage info from response headers */
  onUsageInfo?: (usage: UsageInfo) => void;
  /** Called with provider-reported token counts when the stream carries them. */
  onTokenUsage?: (usage: TokenUsage) => void;
}

const STREAM_REQUEST_TIMEOUT_MS = 45_000;

/**
 * Stream a chat completion from the LLM proxy.
 * Parses SSE format (data: {...}\n\n).
 */
export async function streamChat(options: StreamOptions): Promise<void> {
  const { proxyUrl, model, messages, system, signal, onChunk, onComplete, onError, onUsageInfo, onFinishReason, onTokenUsage } = options;
  const isDev = Boolean((import.meta as unknown as { env?: Record<string, unknown> }).env?.DEV);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Shape the system prompt with cache_control markers when it's
  // long enough to be worth caching. The proxy passes the body
  // through to Anthropic, which accepts both string and array forms.
  // Authoring turns (which ship the ~5 KiB manifest/widget/capability
  // contract) hit this path; one-shot turns fall under the threshold
  // and pass through as plain string.
  let maxOutputTokens: number;
  try { maxOutputTokens = outputTokenLimit(options.maxOutputTokens, PROXY_OUTPUT_TOKEN_CEILING); }
  catch (error) { onError(error instanceof Error ? error : new Error(String(error))); return; }
  const requestBody = JSON.stringify({
    messages,
    model,
    maxOutputTokens,
    system: buildCacheableSystem(system),
  });
  const fetchChat = async (url: string) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('Chat request timed out. Please try again.')), STREAM_REQUEST_TIMEOUT_MS);
    const abortFromParent = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutId);
        controller.abort(signal.reason);
      } else {
        signal.addEventListener('abort', abortFromParent, { once: true });
      }
    }
    try {
      return await fetch(url, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted && controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortFromParent);
    }
  };
  const canFallbackToAppProxy = isDev && proxyUrl !== '/api/chat';

  let response: Response;
  try {
    response = await fetchChat(proxyUrl);
  } catch (err) {
    if (signal?.aborted) return;
    if (!canFallbackToAppProxy) {
      onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // Local dev resilience: if direct API URL is down/unreachable, retry once
    // through app-relative proxy path.
    try {
      response = await fetchChat('/api/chat');
    } catch (fallbackErr) {
      if (signal?.aborted) return;
      onError(fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)));
      return;
    }
  }

  // Local dev resilience: if direct API URL 404s (common when vercel dev
  // port/process changes), retry once through the app proxy path.
  if (!response.ok && response.status === 404 && canFallbackToAppProxy) {
    try {
      const retry = await fetchChat('/api/chat');
      if (retry.ok || retry.status !== 404) {
        response = retry;
      }
    } catch {
      // ignore fallback failure, original response handling below will surface error
    }
  }

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status}`;
    try {
      const errorBody = await response.json() as {
        error?: string;
        code?: string;
        providerMessage?: string;
        model?: string;
        type?: string;
        upgrade?: boolean;
        contactEmail?: string;
        resetAt?: number;
      };
      errorDetail = errorBody.error || errorDetail;

      if (response.status === 401) {
        errorDetail = 'Authentication error.';
      }

      if (response.status === 429) {
        if (errorBody.type === 'request_cap') {
          errorDetail = errorBody.error || 'Daily limit reached. Add your own API key in Settings for unlimited access.';
        } else {
          errorDetail = errorBody.error || 'Limit reached. Please try again later.';
        }
      }

      if (response.status === 502 && errorBody.code === 'provider_model_not_found') {
        const providerMessage = errorBody.providerMessage?.trim();
        const modelLabel = errorBody.model ? ` ${errorBody.model}` : '';
        // The provider's own text is usually addressed to whoever configures the
        // routing, not to the person sitting in front of the viewer: when a free
        // tier ends it says to migrate to a paid slug (#2886), which nobody can
        // do from here. Switching model is the one thing that always works in
        // this app, so say it in both branches -- it used to appear only when
        // the provider stayed silent, i.e. it was withheld from exactly the
        // users who had been handed an instruction they could not act on.
        errorDetail = providerMessage
          ? `Provider routing unavailable for${modelLabel}. ${providerMessage} Switch model to continue.`
          : `Provider routing unavailable for${modelLabel}. Try again shortly or switch model.`;
      }

      if (errorBody.code === 'provider_error' && errorBody.providerMessage) {
        errorDetail = `${errorBody.error ?? `Request failed (${response.status})`}\nProvider: ${errorBody.providerMessage}`;
      }
    } catch {
      // ignore parse failure
    }
    onError(new Error(errorDetail));
    return;
  }

  // Extract usage info from response headers
  if (onUsageInfo) {
    const usage = parseUsageFromHeaders(response.headers);
    if (usage) {
      onUsageInfo(usage);
    }
  }

  if (!response.body) {
    onError(new Error('No response body'));
    return;
  }

  let fullText = '';
  let finishReason: string | null = null;

  const ok = await readSseStream(response.body, signal, (data) => {
    const parsed = JSON.parse(data) as {
      __ifcLiteUsage?: UsageInfo & {
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      choices?: Array<{
        delta?: { content?: string };
        finish_reason?: string | null;
      }>;
    };

    // Final usage update emitted by proxy after stream-end reconciliation.
    if (parsed.__ifcLiteUsage && onUsageInfo) {
      onUsageInfo(parsed.__ifcLiteUsage);
      // Surface cache hit/miss numbers under the same logger as the
      // direct path; observability stays consistent across both flows.
      logCacheHit(parsed.__ifcLiteUsage);
      return;
    }

    // The proxy forwards upstream chunks verbatim, so a provider usage chunk arrives as-is.
    const tokenUsage = chatCompletionsUsage(parsed);
    if (tokenUsage) onTokenUsage?.(tokenUsage);

    const content = parsed.choices?.[0]?.delta?.content;
    if (content) {
      fullText += content;
      onChunk(content);
    }
    const chunkFinishReason = parsed.choices?.[0]?.finish_reason;
    if (chunkFinishReason) {
      finishReason = chunkFinishReason;
    }
  }, onError);

  if (!ok) return;

  onFinishReason?.(finishReason);
  onComplete(fullText);
}
