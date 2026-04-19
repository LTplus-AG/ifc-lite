/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Streaming client for the LLM chat proxy.
 *
 * Sends chat messages to the Edge proxy and streams the response
 * back as SSE. Extracts usage headers from the response for UI display.
 */

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
}

const STREAM_REQUEST_TIMEOUT_MS = 45_000;

function parseUsageFromHeaders(headers: Headers): UsageInfo | null {
  const creditsUsed = parseInt(headers.get('X-Credits-Used') ?? '0', 10);
  const creditsLimit = parseInt(headers.get('X-Credits-Limit') ?? '0', 10);
  const usageUsed = parseInt(headers.get('X-Usage-Used') ?? '0', 10);
  const usageLimit = parseInt(headers.get('X-Usage-Limit') ?? '0', 10);

  if (creditsLimit > 0) {
    const billable = headers.get('X-Credits-Billable');
    return {
      type: 'credits',
      used: creditsUsed,
      limit: creditsLimit,
      pct: parseInt(headers.get('X-Credits-Pct') ?? '0', 10),
      resetAt: parseInt(headers.get('X-Credits-Reset') ?? '0', 10),
      billable: billable === null ? undefined : billable === 'true',
    };
  }

  if (usageLimit > 0) {
    return {
      type: 'requests',
      used: usageUsed,
      limit: usageLimit,
      pct: parseInt(headers.get('X-Usage-Pct') ?? '0', 10),
      resetAt: parseInt(headers.get('X-Usage-Reset') ?? '0', 10),
    };
  }

  return null;
}

export function drainSseBuffer(buffer: string, flush: boolean = false): { events: string[]; remainder: string } {
  if (flush) {
    const trimmed = buffer.trim();
    return {
      events: trimmed ? trimmed.split('\n\n').filter(Boolean) : [],
      remainder: '',
    };
  }
  const parts = buffer.split('\n\n');
  return {
    events: parts.slice(0, -1).filter(Boolean),
    remainder: parts.at(-1) ?? '',
  };
}

/**
 * Fetch current usage snapshot without sending a chat message.
 * Used for instant UI hydration and periodic refresh.
 */
export async function fetchUsageSnapshot(proxyUrl: string): Promise<UsageInfo | null> {
  const isDev = Boolean((import.meta as unknown as { env?: Record<string, unknown> }).env?.DEV);
  const headers: Record<string, string> = {};

  const snapshotUrl = `${proxyUrl}${proxyUrl.includes('?') ? '&' : '?'}usage=1`;
  const appSnapshotUrl = '/api/chat?usage=1';
  const canFallbackToAppProxy = isDev && snapshotUrl !== appSnapshotUrl;
  const fetchSnapshot = (url: string) => fetch(url, { method: 'GET', headers });

  let response: Response;
  try {
    response = await fetchSnapshot(snapshotUrl);
  } catch {
    if (!canFallbackToAppProxy) return null;
    try {
      response = await fetchSnapshot(appSnapshotUrl);
    } catch {
      return null;
    }
  }

  if (!response.ok && response.status === 404 && canFallbackToAppProxy) {
    try {
      const retry = await fetchSnapshot(appSnapshotUrl);
      if (retry.ok || retry.status !== 404) {
        response = retry;
      }
    } catch {
      // keep original response
    }
  }

  if (!response.ok) return null;
  return parseUsageFromHeaders(response.headers);
}

/**
 * Stream a chat completion from the LLM proxy.
 * Parses SSE format (data: {...}\n\n).
 */
export async function streamChat(options: StreamOptions): Promise<void> {
  const { proxyUrl, model, messages, system, signal, onChunk, onComplete, onError, onUsageInfo, onFinishReason } = options;
  const isDev = Boolean((import.meta as unknown as { env?: Record<string, unknown> }).env?.DEV);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const requestBody = JSON.stringify({ messages, model, system });
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
        if (providerMessage) {
          errorDetail = `Provider routing unavailable for${modelLabel}. ${providerMessage}`;
        } else {
          errorDetail = `Provider routing unavailable for${modelLabel}. Try again shortly or switch model.`;
        }
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

  // Parse SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let finishReason: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const drained = drainSseBuffer(buffer);
      buffer = drained.remainder;

      for (const event of drained.events) {
        for (const line of event.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);

          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data) as {
              __ifcLiteUsage?: UsageInfo;
              choices?: Array<{
                delta?: { content?: string };
                finish_reason?: string | null;
              }>;
            };

            // Final usage update emitted by proxy after stream-end reconciliation.
            if (parsed.__ifcLiteUsage && onUsageInfo) {
              onUsageInfo(parsed.__ifcLiteUsage);
              continue;
            }

            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              fullText += content;
              onChunk(content);
            }
            const chunkFinishReason = parsed.choices?.[0]?.finish_reason;
            if (chunkFinishReason) {
              finishReason = chunkFinishReason;
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    }
    buffer += decoder.decode();
    const drained = drainSseBuffer(buffer, true);
    for (const event of drained.events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);

        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data) as {
            __ifcLiteUsage?: UsageInfo;
            choices?: Array<{
              delta?: { content?: string };
              finish_reason?: string | null;
            }>;
          };

          if (parsed.__ifcLiteUsage && onUsageInfo) {
            onUsageInfo(parsed.__ifcLiteUsage);
            continue;
          }

          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            fullText += content;
            onChunk(content);
          }
          const chunkFinishReason = parsed.choices?.[0]?.finish_reason;
          if (chunkFinishReason) {
            finishReason = chunkFinishReason;
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return;
    onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  onFinishReason?.(finishReason);
  onComplete(fullText);
}
