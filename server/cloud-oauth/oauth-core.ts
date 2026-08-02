/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Provider-agnostic core for the server-side OAuth 2.0 authorization-code flow
 * (confidential client + offline refresh token) shared by every cloud storage
 * provider (Dropbox, Google Drive, …).
 *
 * The browser never sees the app secret or the long-lived refresh token — those
 * stay server-side (the refresh token in an httpOnly cookie). The browser only
 * receives short-lived access tokens, which it uses to talk to the provider's
 * API directly, so file bytes never pass through our servers.
 *
 * A concrete provider is described by an `OAuthProviderSpec`; network calls take
 * an injected `fetchImpl` so the flow is unit-testable without hitting the
 * provider.
 */

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface OAuthProviderSpec {
  /** Stable id, also the URL segment: `/api/<id>/…`. */
  id: string;
  /** Consent-screen endpoint. */
  authorizeUrl: string;
  /** Token endpoint (code exchange + refresh). */
  tokenUrl: string;
  /** Requested OAuth scopes. */
  scopes: string[];
  /**
   * Extra authorize-URL params that make the provider return a durable refresh
   * token (e.g. Dropbox `token_access_type=offline`; Google
   * `access_type=offline` + `prompt=consent`).
   */
  authorizeParams: Record<string, string>;
  /** Env var names holding the client id / secret. */
  envKeys: { id: string; secret: string };
}

/** Cookie that carries the CSRF state across the authorize round-trip. */
export function stateCookieName(spec: OAuthProviderSpec): string {
  return `${spec.id}_oauth_state`;
}

/** Cookie that stores the long-lived refresh token (httpOnly, never read by JS). */
export function refreshCookieName(spec: OAuthProviderSpec): string {
  return `${spec.id}_refresh`;
}

/** The path the refresh cookie is scoped to — only sent to this provider's routes. */
export function cookiePath(spec: OAuthProviderSpec): string {
  return `/api/${spec.id}`;
}

/**
 * Read a provider's client credentials from an environment bag. Returns `null`
 * (rather than throwing) when unconfigured so callers can degrade gracefully — a
 * deploy without the secrets simply reports "not configured" to the UI.
 */
export function loadOAuthConfig(
  spec: OAuthProviderSpec,
  env: Record<string, string | undefined>,
): OAuthClientConfig | null {
  const clientId = env[spec.envKeys.id]?.trim();
  const clientSecret = env[spec.envKeys.secret]?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export interface AuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
}

/** Build the provider consent-screen URL the user is sent to. */
export function buildAuthorizeUrl(
  spec: OAuthProviderSpec,
  { clientId, redirectUri, state }: AuthorizeUrlParams,
): string {
  const url = new URL(spec.authorizeUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', spec.scopes.join(' '));
  url.searchParams.set('state', state);
  for (const [key, value] of Object.entries(spec.authorizeParams)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
  scope?: string;
  account_id?: string;
}

/** Thrown when the provider rejects a token exchange/refresh; carries the HTTP status. */
export class OAuthTokenError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`OAuth token endpoint returned ${status}: ${detail}`);
    this.name = 'OAuthTokenError';
  }
}

/**
 * A stalled provider token endpoint would otherwise occupy the edge handler
 * until the platform's own (much longer, and not ours to tune) request
 * timeout. Bounding it here makes a hung upstream fail fast and predictably,
 * as a transient (non-`OAuthTokenError`) failure — see the retryable-vs-fatal
 * split in `oauth-handlers.ts`'s `token` handler.
 */
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

async function postToken(
  spec: OAuthProviderSpec,
  fetchImpl: typeof fetch,
  config: OAuthClientConfig,
  body: Record<string, string>,
): Promise<OAuthTokenResponse> {
  const params = new URLSearchParams({
    ...body,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const res = await fetchImpl(spec.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new OAuthTokenError(res.status, detail);
  }
  return (await res.json()) as OAuthTokenResponse;
}

/** Exchange a one-time authorization `code` for an access + refresh token pair. */
export function exchangeCodeForTokens(
  spec: OAuthProviderSpec,
  fetchImpl: typeof fetch,
  config: OAuthClientConfig,
  params: { code: string; redirectUri: string },
): Promise<OAuthTokenResponse> {
  return postToken(spec, fetchImpl, config, {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
  });
}

/** Mint a fresh short-lived access token from a stored refresh token. */
export function refreshAccessToken(
  spec: OAuthProviderSpec,
  fetchImpl: typeof fetch,
  config: OAuthClientConfig,
  refreshToken: string,
): Promise<OAuthTokenResponse> {
  return postToken(spec, fetchImpl, config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

// ── Cookie helpers ───────────────────────────────────────────────────────────

/** Parse a `Cookie` request header into a name→value map. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    // Untrusted client input: a malformed percent-encoding (e.g. `%zz`) makes
    // decodeURIComponent throw, which must not crash the whole request — fall
    // back to the raw value for that one cookie.
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAge?: number; // seconds; omit for a session cookie, 0 to expire now
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
}

/** Serialize a single `Set-Cookie` value. */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${opts.path ?? '/'}`);
  if (opts.maxAge !== undefined) segments.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly) segments.push('HttpOnly');
  if (opts.secure) segments.push('Secure');
  segments.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  return segments.join('; ');
}

/** Cryptographically-random URL-safe state token for CSRF protection. */
export function randomState(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Derive the OAuth redirect URI for a request, scoped to the provider's routes. */
export function redirectUriFor(spec: OAuthProviderSpec, requestUrl: string): string {
  const url = new URL(requestUrl);
  return `${url.origin}${cookiePath(spec)}/auth-callback`;
}
