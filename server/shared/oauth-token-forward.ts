/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The upstream half of a server-held OAuth token relay, shared by the BCF
 * relay (`server/bcf/oauth-token-relay.ts`) and the buildagil relay
 * (`server/sources/buildagil-relay.ts`). The caller validates the grant and
 * builds the form, client secret included; this posts it to a fixed token
 * URL without following redirects and hands back only what a browser may
 * see: the RFC 6749 §5.1 token fields, or the §5.2 error fields with the
 * secret scrubbed.
 */

const MAX_ERROR_FIELD_LENGTH = 500;

/** Token response fields passed back; anything else the vendor adds is dropped. */
const TOKEN_RESPONSE_FIELDS = [
  'access_token',
  'token_type',
  'expires_in',
  'refresh_token',
  'scope',
  'id_token',
] as const;

export function tokenJson(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // RFC 6749 §5.1: token responses must not be cached, by anyone.
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

export function tokenRelayError(status: number, error: string, description: string, extra?: Record<string, string>): Response {
  return tokenJson(status, { error, error_description: description }, extra);
}

export type CappedRead = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'invalid' };

/** Reads a body as UTF-8, refusing it as soon as it passes `max` bytes. */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  declaredLength: string | null,
  max: number,
): Promise<CappedRead> {
  if (declaredLength !== null && Number(declaredLength) > max) return { ok: false, reason: 'too_large' };
  if (!body) return { ok: true, text: '' };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Upstream error body cut down to the two RFC 6749 §5.2 fields, secret scrubbed. */
function redactedUpstreamError(parsed: unknown, secret: string): Record<string, string> {
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const scrub = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value === '') return undefined;
    const clean = secret ? value.split(secret).join('[redacted]') : value;
    return clean.slice(0, MAX_ERROR_FIELD_LENGTH);
  };
  const out: Record<string, string> = { error: scrub(record.error) ?? 'upstream_error' };
  const description = scrub(record.error_description);
  if (description) out.error_description = description;
  return out;
}

export interface TokenForward {
  /** Fixed upstream token URL, never caller-supplied as-is. */
  readonly tokenUrl: string;
  /** The complete grant form, client credentials included. */
  readonly form: URLSearchParams;
  /** Scrubbed from every error text that reaches the caller. */
  readonly clientSecret: string;
  /** Vendor name for error descriptions, e.g. `BIMcollab`. */
  readonly vendor: string;
  /** Log prefix, e.g. `[bcf-token-relay]`. */
  readonly logTag: string;
  readonly upstreamTimeoutMs: number;
  /** Cap on the upstream response body. */
  readonly maxBodyBytes: number;
  readonly fetchImpl: typeof fetch;
}

/** Posts one grant upstream and returns the filtered token or error response. */
export async function forwardTokenGrant(request: TokenForward): Promise<Response> {
  const { vendor } = request;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.upstreamTimeoutMs);
  let upstream: Response;
  let upstreamBody: CappedRead;
  try {
    upstream = await request.fetchImpl(request.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: request.form.toString(),
      // Following a 3xx would re-post the form, client_secret included, to
      // wherever the Location names.
      redirect: 'manual',
      signal: controller.signal,
    });
    upstreamBody = await readCapped(upstream.body, upstream.headers.get('content-length'), request.maxBodyBytes);
  } catch (err) {
    // Name only: the request this failed on carries the secret.
    const name = err instanceof Error ? err.name : typeof err;
    console.warn(`${request.logTag} upstream token request failed:`, name);
    return controller.signal.aborted
      ? tokenRelayError(504, 'upstream_timeout', `The ${vendor} token endpoint did not answer in time`)
      : tokenRelayError(502, 'upstream_unreachable', `The ${vendor} token endpoint could not be reached`);
  } finally {
    clearTimeout(timer);
  }

  // `redirect: 'manual'` yields the 3xx itself on the server, an
  // opaque-redirect (status 0) in a browser-like fetch.
  if ((upstream.status >= 300 && upstream.status < 400) || upstream.type === 'opaqueredirect') {
    return tokenRelayError(502, 'upstream_redirect', `The ${vendor} token endpoint redirected; refusing to follow`);
  }
  const parsed = upstreamBody.ok ? parseJson(upstreamBody.text) : undefined;

  if (!upstream.ok) {
    // Pass 4xx through so the viewer still sees invalid_grant and friends;
    // a vendor-side 5xx is our gateway's failure, not the caller's.
    const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
    return tokenJson(status, redactedUpstreamError(parsed, request.clientSecret));
  }

  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  if (!record || typeof record.access_token !== 'string' || record.access_token === '') {
    return tokenRelayError(502, 'invalid_upstream_response', `The ${vendor} token endpoint returned no access_token`);
  }
  const token: Record<string, unknown> = {};
  for (const field of TOKEN_RESPONSE_FIELDS) {
    if (record[field] !== undefined) token[field] = record[field];
  }
  return tokenJson(200, token);
}
