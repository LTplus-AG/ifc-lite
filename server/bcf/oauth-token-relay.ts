/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Same-origin OAuth token relay for BCF vendor apps that are CONFIDENTIAL
 * clients (#4919).
 *
 * BIMcollab issued IFClite's production client as confidential: its token
 * endpoint answers a code exchange without `client_secret` with
 * `invalid_client`. The secret cannot ship in the browser bundle, so the two
 * token grants the viewer needs, the authorization-code exchange and the
 * refresh, come through here and the secret is added server-side. The
 * authorization request itself still runs in the popup with PKCE.
 *
 * What keeps this from being a credentialed open proxy:
 *
 *   - Exactly two grants, each with an exact set of fields. Nothing the
 *     caller sends is forwarded beyond those, so it cannot add `scope`,
 *     another `client_id`, or a grant this relay does not mean to offer.
 *   - The token URL must be `https://<one label>.bimcollab.com/identity/connect/token`
 *     (the per-space endpoint `/bcf/2.1/auth` advertises), and the upstream
 *     URL is rebuilt from the validated host rather than forwarded. No
 *     userinfo, port, query or other path reaches the network, so the secret
 *     can only ever be posted to a BIMcollab space's token endpoint.
 *   - `redirectUri` must be one the deployment registered, the authorization
 *     code exchange requires a PKCE verifier, and redirects are never
 *     followed (a 3xx would otherwise re-post the form, secret included).
 *   - Origin must be on the allowlist and the body must be JSON, which a
 *     cross-site form cannot send without a preflight this endpoint never
 *     answers.
 *   - Upstream error bodies are reduced to `error` / `error_description`,
 *     and any occurrence of the secret is scrubbed from those too.
 *
 * Residual risk, documented rather than papered over: a caller who already
 * holds a valid refresh token, or a code and its verifier, can use this to
 * redeem it without the secret, because that is exactly the service the
 * relay provides to the viewer, and Origin is forgeable outside a browser.
 * The relay holds no user credential of its own, so it cannot mint tokens
 * for anyone, and the secret never leaves it. Put a Vercel WAF rate-limit
 * rule on `/api/bcf/oauth/token` like the one on `/api/dalux`.
 */

import { parseRelayGrant, upstreamTokenForm } from './bimcollab-token-grant.js';

/** Callbacks registered with BIMcollab for IFClite's production client. */
export const BIMCOLLAB_REGISTERED_REDIRECT_URIS: readonly string[] = [
  'https://www.ifclite.com/oauth/bcf/callback',
  'http://localhost:5000/oauth/bcf/callback',
];

/**
 * `error` code of the 503 an unconfigured deployment answers. The viewer
 * matches on it to fall back to a direct exchange
 * (`apps/viewer/src/services/bcf-token-relay.ts`), so it is a contract.
 */
export const RELAY_NOT_CONFIGURED = 'relay_not_configured';

export interface BcfTokenRelayConfig {
  /** Vendor client id; empty means the relay is not configured. */
  readonly clientId: string;
  /** Vendor client secret; empty means the relay is not configured. */
  readonly clientSecret: string;
  /** `redirect_uri` values a code exchange may name, compared exactly. */
  readonly allowedRedirectUris: readonly string[];
  /** Browser origins allowed to call the relay. */
  readonly allowedOrigins: readonly string[];
  readonly upstreamTimeoutMs: number;
  /** Cap on the request body and on the upstream response body. */
  readonly maxBodyBytes: number;
}

export interface BcfTokenRelayDeps {
  readonly fetchImpl: typeof fetch;
}

const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
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

function json(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}): Response {
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

function relayError(status: number, error: string, description: string, extra?: Record<string, string>): Response {
  return json(status, { error, error_description: description }, extra);
}

type CappedRead = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'invalid' };

/** Reads a body as UTF-8, refusing it as soon as it passes `max` bytes. */
async function readCapped(
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isJsonContentType(value: string | null): boolean {
  return (value ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
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

export function createBcfTokenRelayHandler(
  config: BcfTokenRelayConfig,
  deps: BcfTokenRelayDeps,
): (request: Request) => Promise<Response> {
  return async function handleBcfTokenRelay(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return relayError(405, 'invalid_request', 'Only POST is accepted', { allow: 'POST' });
    }

    // Same-origin only. A browser always sends Origin on a POST; a request
    // without one did not come from the viewer.
    const origin = request.headers.get('origin');
    if (!origin || !config.allowedOrigins.includes(origin)) {
      return relayError(403, 'invalid_request', 'Origin not allowed');
    }
    const fetchSite = request.headers.get('sec-fetch-site');
    if (fetchSite !== null && fetchSite !== 'same-origin') {
      return relayError(403, 'invalid_request', 'Cross-site requests are not accepted');
    }
    if (!isJsonContentType(request.headers.get('content-type'))) {
      return relayError(415, 'invalid_request', 'Content-Type must be application/json');
    }

    if (!config.clientId || !config.clientSecret) {
      return relayError(
        503,
        RELAY_NOT_CONFIGURED,
        'The BIMcollab token relay is not configured on this deployment (BCF_BIMCOLLAB_CLIENT_ID, BCF_BIMCOLLAB_CLIENT_SECRET).',
      );
    }

    const read = await readCapped(request.body, request.headers.get('content-length'), config.maxBodyBytes);
    if (!read.ok) {
      return read.reason === 'too_large'
        ? relayError(413, 'invalid_request', 'Request body too large')
        : relayError(400, 'invalid_request', 'Request body is not UTF-8');
    }
    const grant = parseRelayGrant(parseJson(read.text), config.allowedRedirectUris);
    if ('problem' in grant) return relayError(400, 'invalid_request', grant.problem);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
    let upstream: Response;
    let upstreamBody: CappedRead;
    try {
      upstream = await deps.fetchImpl(grant.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: upstreamTokenForm(grant, config).toString(),
        // Following a 3xx would re-post the form, client_secret included, to
        // wherever the Location names.
        redirect: 'manual',
        signal: controller.signal,
      });
      upstreamBody = await readCapped(upstream.body, upstream.headers.get('content-length'), config.maxBodyBytes);
    } catch (err) {
      // Name only: the request this failed on carries the secret.
      const name = err instanceof Error ? err.name : typeof err;
      console.warn('[bcf-token-relay] upstream token request failed:', name);
      return controller.signal.aborted
        ? relayError(504, 'upstream_timeout', 'The BIMcollab token endpoint did not answer in time')
        : relayError(502, 'upstream_unreachable', 'The BIMcollab token endpoint could not be reached');
    } finally {
      clearTimeout(timer);
    }

    // `redirect: 'manual'` yields the 3xx itself on the server, an
    // opaque-redirect (status 0) in a browser-like fetch.
    if ((upstream.status >= 300 && upstream.status < 400) || upstream.type === 'opaqueredirect') {
      return relayError(502, 'upstream_redirect', 'The BIMcollab token endpoint redirected; refusing to follow');
    }
    const parsed = upstreamBody.ok ? parseJson(upstreamBody.text) : undefined;

    if (!upstream.ok) {
      // Pass 4xx through so the viewer still sees invalid_grant and friends;
      // a vendor-side 5xx is our gateway's failure, not the caller's.
      const status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
      return json(status, redactedUpstreamError(parsed, config.clientSecret));
    }

    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    if (!record || typeof record.access_token !== 'string' || record.access_token === '') {
      return relayError(502, 'invalid_upstream_response', 'The BIMcollab token endpoint returned no access_token');
    }
    const token: Record<string, unknown> = {};
    for (const field of TOKEN_RESPONSE_FIELDS) {
      if (record[field] !== undefined) token[field] = record[field];
    }
    return json(200, token);
  };
}

function listFromEnv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function originsOf(uris: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const uri of uris) {
    try {
      origins.add(new URL(uri).origin);
    } catch {
      console.warn('[bcf-token-relay] ignoring a redirect URI that is not a URL:', uri);
    }
  }
  return [...origins];
}

/**
 * Reads the relay's server-only env. None of these may be `VITE_*`: that
 * prefix is compiled into the browser bundle.
 *
 *   BCF_BIMCOLLAB_CLIENT_ID          required
 *   BCF_BIMCOLLAB_CLIENT_SECRET      required
 *   BCF_BIMCOLLAB_REDIRECT_URIS      comma-separated; default: the registered callbacks
 *   BCF_TOKEN_RELAY_ALLOWED_ORIGINS  comma-separated; default: the redirect URIs' origins
 *
 * The origin default follows from the redirect allowlist: the viewer refuses
 * to start a sign-in anywhere but the redirect URI's own origin, so those are
 * the only origins a legitimate exchange can come from.
 */
export function loadBcfTokenRelayConfig(env: Record<string, string | undefined>): BcfTokenRelayConfig {
  const redirects = listFromEnv(env.BCF_BIMCOLLAB_REDIRECT_URIS);
  const allowedRedirectUris = redirects.length > 0 ? redirects : [...BIMCOLLAB_REGISTERED_REDIRECT_URIS];
  const origins = listFromEnv(env.BCF_TOKEN_RELAY_ALLOWED_ORIGINS);
  return {
    clientId: (env.BCF_BIMCOLLAB_CLIENT_ID ?? '').trim(),
    clientSecret: (env.BCF_BIMCOLLAB_CLIENT_SECRET ?? '').trim(),
    allowedRedirectUris,
    allowedOrigins: origins.length > 0 ? origins : originsOf(allowedRedirectUris),
    upstreamTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  };
}
