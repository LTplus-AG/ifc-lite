/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TokenExchangeError } from './errors.js';
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

interface TokenEndpointResponseBody {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly token_type?: string;
  readonly error?: string;
  readonly error_description?: string;
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
    const detail = parsed?.error
      ? `: ${parsed.error}${parsed.error_description ? ` (${parsed.error_description})` : ''}`
      : '';
    throw new TokenExchangeError(`token endpoint returned ${response.status}${detail}`, response.status);
  }

  if (!parsed || typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
    throw new TokenExchangeError('token endpoint response is missing "access_token"');
  }

  const expiresInSeconds = typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : 3600;

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: now() + expiresInSeconds * 1000,
    scope: parsed.scope,
    tokenType: parsed.token_type,
  };
}
