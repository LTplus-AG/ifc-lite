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

import { forwardTokenGrant, parseJson, readCapped, tokenRelayError } from '../shared/oauth-token-forward.js';
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

function isJsonContentType(value: string | null): boolean {
  return (value ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}

export function createBcfTokenRelayHandler(
  config: BcfTokenRelayConfig,
  deps: BcfTokenRelayDeps,
): (request: Request) => Promise<Response> {
  return async function handleBcfTokenRelay(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return tokenRelayError(405, 'invalid_request', 'Only POST is accepted', { allow: 'POST' });
    }

    // Same-origin only. A browser always sends Origin on a POST; a request
    // without one did not come from the viewer.
    const origin = request.headers.get('origin');
    if (!origin || !config.allowedOrigins.includes(origin)) {
      return tokenRelayError(403, 'invalid_request', 'Origin not allowed');
    }
    const fetchSite = request.headers.get('sec-fetch-site');
    if (fetchSite !== null && fetchSite !== 'same-origin') {
      return tokenRelayError(403, 'invalid_request', 'Cross-site requests are not accepted');
    }
    if (!isJsonContentType(request.headers.get('content-type'))) {
      return tokenRelayError(415, 'invalid_request', 'Content-Type must be application/json');
    }

    if (!config.clientId || !config.clientSecret) {
      return tokenRelayError(
        503,
        RELAY_NOT_CONFIGURED,
        'The BIMcollab token relay is not configured on this deployment (BCF_BIMCOLLAB_CLIENT_ID, BCF_BIMCOLLAB_CLIENT_SECRET).',
      );
    }

    const read = await readCapped(request.body, request.headers.get('content-length'), config.maxBodyBytes);
    if (!read.ok) {
      return read.reason === 'too_large'
        ? tokenRelayError(413, 'invalid_request', 'Request body too large')
        : tokenRelayError(400, 'invalid_request', 'Request body is not UTF-8');
    }
    const grant = parseRelayGrant(parseJson(read.text), config.allowedRedirectUris);
    if ('problem' in grant) return tokenRelayError(400, 'invalid_request', grant.problem);

    return forwardTokenGrant({
      tokenUrl: grant.tokenUrl,
      form: upstreamTokenForm(grant, config),
      clientSecret: config.clientSecret,
      vendor: 'BIMcollab',
      logTag: '[bcf-token-relay]',
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      maxBodyBytes: config.maxBodyBytes,
      fetchImpl: deps.fetchImpl,
    });
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
