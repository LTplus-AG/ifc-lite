/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sanitizeErrorCode, sanitizeErrorDescription, TokenExchangeError } from './errors.js';
import type { TokenSet } from './types.js';

// ============================================================================
// Authorization-code -> token exchange, and refresh-token -> token exchange
// (RFC 6749 §4.1.3 and §6). Both hit the same token endpoint shape, so they
// share `requestToken` below.
//
// Neither function ever includes the request body, the code, the verifier,
// or any token in a thrown error — only the HTTP status and, when the
// response has the standard OAuth `{error, error_description}` shape (RFC
// 6749 §5.2), those two fields. An opaque non-JSON body is never surfaced,
// since a misconfigured relay could echo back something that isn't safe to
// put in a message that ends up in logs or a bug report.
// ============================================================================

export interface ExchangeAuthorizationCodeParams {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly codeVerifier: string;
  /** Injected fetch — never global `fetch` directly, so this stays testable
   *  without a real network call and so a caller can route it through
   *  whatever CORS/relay layer its environment needs. */
  readonly fetch: typeof fetch;
  readonly now?: () => number;
}

/** RFC 6749 §4.1.3 "Access Token Request", with PKCE's `code_verifier`
 *  (RFC 7636 §4.5) replacing the confidential-client secret. No
 *  `client_secret` parameter is sent — this package is for public clients. */
export async function exchangeAuthorizationCode(params: ExchangeAuthorizationCodeParams): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });
  return requestToken(params.tokenEndpoint, body, params.fetch, params.now);
}

export interface RefreshAccessTokenParams {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly scope?: string;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
}

/** RFC 6749 §6 "Refreshing an Access Token". */
export async function refreshAccessToken(params: RefreshAccessTokenParams): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  });
  if (params.scope) body.set('scope', params.scope);
  return requestToken(params.tokenEndpoint, body, params.fetch, params.now);
}

/**
 * What RFC 6749 §5.1/§5.2 say a token-endpoint body contains — declared as
 * `unknown` per field rather than as the string/number types the RFC gives
 * them, because this shape is produced by `JSON.parse` over a network
 * response. Writing `readonly refresh_token?: string` here would be a
 * compile-time assertion about a value the compiler never sees, and would
 * make `requestToken`'s runtime checks below look redundant to a future
 * reader (or get narrowed away by the type checker) when they are the only
 * thing actually establishing those types.
 */
interface TokenEndpointResponseBody {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  // RFC 6749 §5.1 says number, but some providers send it as a numeric
  // string; `requestToken` below coerces either shape with `Number(...)`.
  readonly expires_in?: unknown;
  readonly scope?: unknown;
  readonly token_type?: unknown;
  readonly error?: unknown;
  readonly error_description?: unknown;
}

async function requestToken(
  endpoint: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  now: () => number = Date.now,
): Promise<TokenSet> {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    // RFC 6749 §4.1.3: the token request body is
    // `application/x-www-form-urlencoded`.
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });

  const text = await response.text();
  let parsed: TokenEndpointResponseBody | undefined;
  try {
    parsed = JSON.parse(text) as TokenEndpointResponseBody;
  } catch {
    // Not JSON — nothing safe to parse out of it. Fall through with `parsed`
    // undefined; the status-only error path below still fires for a non-OK
    // response, and an OK response with an unparsable body fails the
    // `access_token` presence check just below.
  }

  if (!response.ok) {
    // `error`/`error_description` are provider-controlled text from a
    // response body — unbounded in length and unrestricted in character set
    // before this point. Same treatment as the authorization-callback path
    // (see `sanitizeErrorCode` in `errors.ts` for why a message that reaches
    // logs and bug reports has to be bounded and inert). Also guarded on
    // being strings at all: a body is only known to be JSON here, not to
    // have the shape RFC 6749 §5.2 describes.
    const rawError = typeof parsed?.error === 'string' ? parsed.error : undefined;
    const rawDescription = typeof parsed?.error_description === 'string' ? parsed.error_description : undefined;
    const description = rawDescription ? ` (${sanitizeErrorDescription(rawDescription)})` : '';
    const detail = rawError ? `: ${sanitizeErrorCode(rawError)}${description}` : '';
    throw new TokenExchangeError(`token endpoint returned ${response.status}${detail}`, response.status);
  }

  if (!parsed || typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
    throw new TokenExchangeError('token endpoint response is missing "access_token"');
  }

  // `access_token` was for a long time the only field checked; the rest were
  // copied through with only a compile-time assertion standing behind them,
  // which says nothing about a JSON body that came off the network. RFC 6749
  // §5.1 defines all four as strings, but a provider that sends
  // `"refresh_token": 12345` produced a `TokenSet` that violated its own
  // declared type — and `TokenManager.getTokens()` runs `isTokenSet` over
  // what it reads back, which fails closed to "no session". A *successful*
  // sign-in then presented as "never signed in", and signing in again
  // reproduced it: an unbreakable loop with nothing anywhere naming the
  // cause.
  //
  // The two cases are not treated the same way, because what they cost
  // differs:
  //
  //  - `refresh_token` is load-bearing. Dropping it would silently downgrade
  //    the session to a non-refreshable one — indistinguishable from a
  //    provider that legitimately issues no refresh token, and only visible
  //    an access-token lifetime later, far from the response that caused it.
  //    Reject the exchange and name the field.
  //  - `scope` and `token_type` are informational; nothing in this package
  //    reads them. Refusing an otherwise-valid sign-in over a non-conforming
  //    value there would be a worse outcome than the value itself, so they
  //    are dropped, which keeps the `TokenSet` honest about its own type.
  if (parsed.refresh_token !== undefined && typeof parsed.refresh_token !== 'string') {
    throw new TokenExchangeError('token endpoint response has a non-string "refresh_token"');
  }

  // RFC 6749 §5.1 specifies `expires_in` as a JSON number, but some
  // providers send it as a numeric string (e.g. `"3600"`). `Number(...)`
  // accepts both; `Number(undefined)` and `Number("not-a-number")` both
  // produce `NaN`, so a genuinely missing or malformed value still falls
  // through to the 3600s default instead of being coerced into `0`.
  const rawExpiresIn = Number(parsed.expires_in);
  const expiresInSeconds = Number.isFinite(rawExpiresIn) && rawExpiresIn > 0 ? rawExpiresIn : 3600;

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: now() + expiresInSeconds * 1000,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : undefined,
  };
}
