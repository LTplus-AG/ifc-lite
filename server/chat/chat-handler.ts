/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface ChatConfig {
  apiBase: string;
  apiKey: string;
  appUrl: string;
  allowedOrigins: string[];
  freeModels: Set<string>;
  freeDailyLimit: number;
  debugCredits: boolean;
}

export type UsageTier = 'pro' | 'free';

export interface UsageSnapshot {
  type: 'credits' | 'requests';
  used: number;
  limit: number;
  pct: number;
  resetAt: number;
  billable?: boolean;
}

export interface UsageReservationResult {
  allowed: boolean;
  snapshot: UsageSnapshot;
}

export interface ChatUsageStore {
  getUsageSnapshot(userId: string, tier: UsageTier): Promise<UsageSnapshot>;
  consumeFreeRequest(userId: string): Promise<UsageReservationResult>;
}

export interface ChatHandlerDeps {
  fetchImpl: typeof fetch;
  usageStore: ChatUsageStore;
  now: () => number;
}

export type HeaderBag = Headers | Record<string, string | string[] | undefined> | undefined;

export type HandlerRequest = Request | {
  method?: string;
  url?: string;
  headers?: HeaderBag;
  json?: () => Promise<unknown>;
  body?: unknown;
};

const USAGE_STORE_TIMEOUT_MS = 8_000;
const PROVIDER_FETCH_TIMEOUT_MS = 20_000;

class ChatHandlerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatHandlerTimeoutError';
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      onTimeout?.();
      reject(new ChatHandlerTimeoutError(message));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'ChatHandlerTimeoutError' || error.name === 'UsageStoreTimeoutError');
}

export function requireEnv(key: string, env: Record<string, string | undefined> = process.env): string {
  const val = env[key]?.trim();
  if (!val) {
    throw new Error(`[chat-config] Missing required env var: ${key}`);
  }
  return val;
}

function getEnvSet(key: string, env: Record<string, string | undefined> = process.env): Set<string> {
  const val = requireEnv(key, env);
  const values = val.split(',').map((s) => s.trim()).filter(Boolean);
  if (values.length === 0) {
    throw new Error(`[chat-config] Env var ${key} must include at least one model`);
  }
  return new Set(values);
}

function getEnvInt(key: string, env: Record<string, string | undefined> = process.env): number {
  const val = requireEnv(key, env);
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) {
    throw new Error(`[chat-config] Env var ${key} must be an integer`);
  }
  return n;
}

export function loadChatConfig(env: Record<string, string | undefined> = process.env): ChatConfig {
  return {
    apiBase: requireEnv('LLM_API_BASE', env).replace(/\/+$/, ''),
    apiKey: requireEnv('LLM_API_KEY', env),
    appUrl: requireEnv('APP_URL', env),
    allowedOrigins: (env.APP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    freeModels: getEnvSet('LLM_FREE_MODELS', env),
    freeDailyLimit: getEnvInt('LLM_FREE_DAILY_LIMIT', env),
    debugCredits: env.LLM_DEBUG_CREDITS === '1' || env.NODE_ENV !== 'production',
  };
}


export function isFreeModel(config: ChatConfig, model: string): boolean {
  return config.freeModels.has(model);
}

function debugCredits(config: ChatConfig, event: string, data: Record<string, unknown>): void {
  if (!config.debugCredits) return;
  try {
    console.log(`[chat-credit] ${event} ${JSON.stringify(data)}`);
  } catch {
    console.log(`[chat-credit] ${event}`);
  }
}

function summarizeUserId(userId: string): string {
  if (!userId) return 'unknown';
  if (userId.length <= 8) return userId;
  return `${userId.slice(0, 4)}...${userId.slice(-4)}`;
}

export function isOriginAllowed(config: ChatConfig, requestOrigin: string | null, isDev: boolean): boolean {
  if (!requestOrigin) return true;
  return isOriginAllowedForUrl(config, requestOrigin, config.appUrl, isDev);
}

function isOriginAllowedForUrl(
  config: ChatConfig,
  requestOrigin: string | null,
  requestUrl: string | URL,
  isDev: boolean,
): boolean {
  if (!requestOrigin) return true;

  try {
    const requestOriginUrl = new URL(requestOrigin);
    const targetUrl = new URL(requestUrl);
    if (requestOriginUrl.origin === targetUrl.origin) {
      return true;
    }
  } catch {
    return false;
  }

  if (requestOrigin === config.appUrl) return true;
  if (config.allowedOrigins.includes(requestOrigin)) return true;

  if (isDev) {
    try {
      const url = new URL(requestOrigin);
      const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (isLocalhost && (url.protocol === 'http:' || url.protocol === 'https:')) {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

function getAllowedOrigin(
  config: ChatConfig,
  requestOrigin: string | null,
  requestUrl: string | URL,
  isDev: boolean,
): string {
  if (requestOrigin && isOriginAllowedForUrl(config, requestOrigin, requestUrl, isDev)) {
    return requestOrigin;
  }
  return config.appUrl;
}

function getCorsHeaders(
  config: ChatConfig,
  requestOrigin: string | null,
  requestUrl: string | URL,
  isDev: boolean,
): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': getAllowedOrigin(config, requestOrigin, requestUrl, isDev),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Expose-Headers': 'X-Credits-Used, X-Credits-Limit, X-Credits-Pct, X-Credits-Reset, X-Credits-Billable, X-Usage-Used, X-Usage-Limit, X-Usage-Pct, X-Usage-Reset',
    Vary: 'Origin',
  };
}

function corsResponse(
  config: ChatConfig,
  status: number,
  requestOrigin: string | null,
  requestUrl: string | URL,
  body?: object,
  extra?: Record<string, string>,
  isDev: boolean = process.env.NODE_ENV !== 'production',
): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { ...getCorsHeaders(config, requestOrigin, requestUrl, isDev), 'Content-Type': 'application/json', ...extra },
  });
}

function buildUsageHeaders(snapshot: UsageSnapshot): Record<string, string> {
  if (snapshot.type === 'credits') {
    return {
      'X-Credits-Used': String(snapshot.used),
      'X-Credits-Limit': String(snapshot.limit),
      'X-Credits-Pct': String(snapshot.pct),
      'X-Credits-Reset': String(snapshot.resetAt),
      'X-Credits-Billable': String(snapshot.billable ?? false),
    };
  }

  return {
    'X-Usage-Used': String(snapshot.used),
    'X-Usage-Limit': String(snapshot.limit),
    'X-Usage-Pct': String(snapshot.pct),
    'X-Usage-Reset': String(snapshot.resetAt),
  };
}

async function hashValue(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getHeader(headers: HeaderBag, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}

function getRequestUrl(req: HandlerRequest, config: ChatConfig): URL {
  const host = getHeader(req.headers, 'x-forwarded-host') ?? getHeader(req.headers, 'host');
  const proto = getHeader(req.headers, 'x-forwarded-proto') ?? 'https';
  const fallbackBase = host ? `${proto}://${host}` : config.appUrl;
  return new URL(req.url ?? '/api/chat', fallbackBase);
}

async function readJsonBody<T>(req: HandlerRequest): Promise<T> {
  if (typeof req.json === 'function') {
    return await req.json() as T;
  }
  if (typeof req.body === 'string') {
    return JSON.parse(req.body) as T;
  }
  if (req.body !== undefined) {
    return req.body as T;
  }
  throw new Error('Invalid JSON body');
}

export async function getAnonymousUserId(req: HandlerRequest): Promise<string> {
  const forwarded = getHeader(req.headers, 'x-forwarded-for')
    ?? getHeader(req.headers, 'x-real-ip')
    ?? getHeader(req.headers, 'cf-connecting-ip');
  const ip = forwarded?.split(',')[0]?.trim();
  if (!ip) return 'anonymous';
  const fingerprint = await hashValue(ip);
  return `anon:${fingerprint.slice(0, 24)}`;
}

export function createChatHandler(config: ChatConfig, deps: ChatHandlerDeps) {
  return async function handler(req: HandlerRequest): Promise<Response> {
    const supportEmail = 'louis@ltplus.com';
    const url = getRequestUrl(req, config);
    const requestOrigin = getHeader(req.headers, 'origin');
    const isDev = process.env.NODE_ENV !== 'production';
    const isUsageSnapshotRequest = req.method === 'GET' && url.searchParams.get('usage') === '1';

    if (req.method === 'OPTIONS') {
      if (!isOriginAllowedForUrl(config, requestOrigin, url, isDev)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 200, headers: getCorsHeaders(config, requestOrigin, url, isDev) });
    }
    if (req.method !== 'POST' && !isUsageSnapshotRequest) {
      return corsResponse(config, 405, requestOrigin, url, { error: 'Method not allowed' }, undefined, isDev);
    }
    if (!isOriginAllowedForUrl(config, requestOrigin, url, isDev)) {
      return new Response(JSON.stringify({ error: 'Origin not allowed', code: 'origin_not_allowed' }), {
        status: 403,
        headers: { ...getCorsHeaders(config, requestOrigin, url, isDev), 'Content-Type': 'application/json' },
      });
    }

    // All proxy requests are anonymous free tier — identified by IP hash
    const userId = await getAnonymousUserId(req);

    if (isUsageSnapshotRequest) {
      try {
        const snapshot = await withTimeout(
          deps.usageStore.getUsageSnapshot(userId, 'free'),
          USAGE_STORE_TIMEOUT_MS,
          'Usage store timed out while loading usage.',
        );
        return corsResponse(
          config,
          200,
          requestOrigin,
          url,
          { usage: snapshot },
          buildUsageHeaders(snapshot),
          isDev,
        );
      } catch (error) {
        if (isTimeoutError(error)) {
          return corsResponse(config, 504, requestOrigin, url, {
            error: 'Usage service timed out while loading your chat quota.',
            code: 'usage_store_timeout',
          }, undefined, isDev);
        }
        return corsResponse(config, 502, requestOrigin, url, {
          error: 'Usage service failed while loading your chat quota.',
          code: 'usage_store_error',
        }, undefined, isDev);
      }
    }

    let body: {
      messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
      model: string;
      system?: string;
    };
    try {
      body = await readJsonBody<typeof body>(req);
    } catch {
      return corsResponse(config, 400, requestOrigin, url, { error: 'Invalid JSON body' }, undefined, isDev);
    }

    if (!body?.messages || !body?.model) {
      return corsResponse(config, 400, requestOrigin, url, { error: 'Missing messages or model' }, undefined, isDev);
    }

    if (!isFreeModel(config, body.model)) {
      return corsResponse(config, 400, requestOrigin, url, {
        error: `Model not available through proxy: ${body.model}. Use your own API key for non-free models.`,
        code: 'model_not_allowed',
        model: body.model,
      }, undefined, isDev);
    }

    let usageSnapshot: UsageSnapshot;

    try {
      usageSnapshot = await withTimeout(
        deps.usageStore.getUsageSnapshot(userId, 'free'),
        USAGE_STORE_TIMEOUT_MS,
        'Usage store timed out while loading usage.',
      );

      const consumed = await withTimeout(
        deps.usageStore.consumeFreeRequest(userId),
        USAGE_STORE_TIMEOUT_MS,
        'Usage store timed out while reserving a free request.',
      );
      usageSnapshot = consumed.snapshot;
      if (!consumed.allowed) {
        return corsResponse(config, 429, requestOrigin, url, {
          error: 'You\'ve reached your daily limit. Add your own API key in Settings for unlimited access.',
          type: 'request_cap',
          code: 'quota_exceeded',
          limit: config.freeDailyLimit,
          resetAt: consumed.snapshot.resetAt * 1000,
        }, {
          'Retry-After': String(Math.max(1, consumed.snapshot.resetAt - Math.ceil(deps.now() / 1000))),
          ...buildUsageHeaders(consumed.snapshot),
        }, isDev);
      }
    } catch (error) {
      if (isTimeoutError(error)) {
        return corsResponse(config, 504, requestOrigin, url, {
          error: 'Usage service timed out while preparing the request.',
          code: 'usage_store_timeout',
        }, undefined, isDev);
      }
      return corsResponse(config, 502, requestOrigin, url, {
        error: 'Usage service failed while preparing the request.',
        code: 'usage_store_error',
      }, undefined, isDev);
    }

    const upstreamMessages = body.system
      ? [{ role: 'system', content: body.system }, ...body.messages]
      : body.messages;

    debugCredits(config, 'request_start', {
      userId: summarizeUserId(userId),
      model: body.model,
    });

    let upstream: Response;
    try {
      const controller = new AbortController();
      upstream = await withTimeout(
        deps.fetchImpl(`${config.apiBase}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': config.appUrl,
            'X-Title': 'ifc-lite',
          },
          body: JSON.stringify({
            model: body.model,
            messages: upstreamMessages,
            stream: true,
            temperature: 0.3,
            max_tokens: 8192,
          }),
          signal: controller.signal,
        }),
        PROVIDER_FETCH_TIMEOUT_MS,
        'Provider request timed out before a response was received.',
        () => controller.abort(),
      );
    } catch (error) {
      // No credits to release for free-tier proxy
      if (isTimeoutError(error)) {
        return corsResponse(config, 504, requestOrigin, url, {
          error: 'Provider request timed out before a response was received.',
          code: 'provider_timeout',
        }, undefined, isDev);
      }
      return corsResponse(config, 502, requestOrigin, url, {
        error: 'Provider request failed before a response was received.',
        code: 'provider_unreachable',
        providerMessage: error instanceof Error ? error.message : String(error),
      }, undefined, isDev);
    }

    if (!upstream.ok) {
      // No credits to release for free-tier proxy

      let providerErrorText = '';
      let providerBody: unknown = null;
      try {
        providerErrorText = await upstream.text();
        providerBody = providerErrorText ? JSON.parse(providerErrorText) : null;
      } catch {
        providerBody = null;
      }

      if (upstream.status === 429) {
        return corsResponse(config, 429, requestOrigin, url, {
          error: `Provider rate limit reached for model ${body.model}. Please retry shortly or switch models.`,
          type: 'provider_rate_limit',
          code: 'provider_rate_limited',
          limit: config.freeDailyLimit,
          model: body.model,
        }, undefined, isDev);
      }

      if (upstream.status === 404) {
        const providerMessage = typeof providerBody === 'object' && providerBody !== null
          ? (providerBody as { error?: { message?: string } }).error?.message
          : undefined;
        return corsResponse(config, 502, requestOrigin, url, {
          error: `Model "${body.model}" is currently unavailable from provider routing.`,
          code: 'provider_model_not_found',
          model: body.model,
          providerStatus: 404,
          providerMessage: providerMessage ?? (providerErrorText || undefined),
        }, undefined, isDev);
      }

      if (upstream.status === 402) {
        return corsResponse(config, 502, requestOrigin, url, {
          error: 'Service temporarily unavailable. Please try again later.',
        }, undefined, isDev);
      }

      const providerMessage = typeof providerBody === 'object' && providerBody !== null
        ? (providerBody as { error?: { message?: string } }).error?.message
        : undefined;

      return corsResponse(config, upstream.status, requestOrigin, url, {
        error: `Request failed (${upstream.status}) for model ${body.model}.`,
        code: 'provider_error',
        model: body.model,
        providerStatus: upstream.status,
        providerMessage: providerMessage ?? (providerErrorText || undefined),
      }, undefined, isDev);
    }

    if (!upstream.body) {
      // No credits to release for free-tier proxy
      return corsResponse(config, 502, requestOrigin, url, { error: 'No response body' }, undefined, isDev);
    }

    const finalUsageSnapshot = { ...usageSnapshot };
    const usageHeaders = buildUsageHeaders(finalUsageSnapshot);
    const sseEncoder = new TextEncoder();

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush(controller) {
        const usageEvent = JSON.stringify({
          __ifcLiteUsage: finalUsageSnapshot,
        });
        debugCredits(config, 'usage_event_emitted', {
          userId: summarizeUserId(userId),
          usageType: finalUsageSnapshot.type,
          usageUsed: finalUsageSnapshot.used,
          usageLimit: finalUsageSnapshot.limit,
          pct: finalUsageSnapshot.pct,
          billable: false,
        });
        controller.enqueue(sseEncoder.encode(`data: ${usageEvent}\n\n`));
      },
    });

    upstream.body.pipeTo(writable).catch((error) => {
      debugCredits(config, 'stream_pipe_failed', {
        userId: summarizeUserId(userId),
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return new Response(readable, {
      status: 200,
      headers: {
        ...getCorsHeaders(config, requestOrigin, url, isDev),
        ...usageHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  };
}
