/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FoundationAuthenticationError, extractErrorDetail } from './errors.js';
import { resolveFetch } from './http-client.js';
import type { FoundationTokenResponse, FetchLike } from './types.js';

interface TokenRequestOptions {
  /** OAuth2 token endpoint, from the server's `/auth` discovery document. */
  tokenUrl: string;
  /** Public client id, when the server requires one. */
  clientId?: string;
  /** Client secret; only for servers whose token endpoint demands it. */
  clientSecret?: string;
  fetchFn?: FetchLike;
  /** Prefix of thrown errors' `name` (see `FoundationApiError`); defaults to 'Foundation'. */
  errorNamespace?: string;
}

export interface PasswordGrantOptions extends TokenRequestOptions {
  username: string;
  password: string;
}

export interface RefreshGrantOptions extends TokenRequestOptions {
  refreshToken: string;
}

export interface ClientCredentialsGrantOptions extends TokenRequestOptions {
  clientId: string;
  clientSecret: string;
}

export interface AuthorizationCodeGrantOptions extends TokenRequestOptions {
  /** The `code` returned to the redirect URI by the authorization server. */
  code: string;
  /** Must byte-match the `redirect_uri` sent on the authorization request. */
  redirectUri: string;
  /** PKCE verifier when the authorization request carried a challenge. */
  codeVerifier?: string;
}

/** Request body of the Foundation API dynamic client registration endpoint. */
export interface RegisterClientOptions {
  /** The server's `oauth2_dynamic_client_reg_url` from `/auth` discovery. */
  registrationUrl: string;
  clientName: string;
  clientDescription?: string;
  clientUrl?: string;
  redirectUrl?: string;
  fetchFn?: FetchLike;
  /** Prefix of thrown errors' `name` (see `FoundationApiError`); defaults to 'Foundation'. */
  errorNamespace?: string;
}

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
}

async function postTokenRequest(
  options: TokenRequestOptions,
  form: Record<string, string>,
): Promise<FoundationTokenResponse> {
  const fetchFn = resolveFetch(options.fetchFn);
  const body = new URLSearchParams(form);
  if (options.clientId) body.set('client_id', options.clientId);
  if (options.clientSecret) body.set('client_secret', options.clientSecret);

  const response = await fetchFn(options.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    if (response.ok) {
      throw new FoundationAuthenticationError('Token endpoint returned a non-JSON response', {
        status: response.status,
        url: options.tokenUrl,
        namespace: options.errorNamespace,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    parsed = undefined;
  }

  if (!response.ok) {
    const record =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const errorCode = typeof record.error === 'string' ? record.error : undefined;
    const detail = extractErrorDetail(parsed);
    throw new FoundationAuthenticationError(
      detail ?? `Token request failed (HTTP ${response.status})`,
      { status: response.status, url: options.tokenUrl, errorCode, detail, namespace: options.errorNamespace },
    );
  }

  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const accessToken = record.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new FoundationAuthenticationError('Token response carried no access_token', {
      status: response.status,
      url: options.tokenUrl,
        namespace: options.errorNamespace,
    });
  }
  return {
    access_token: accessToken,
    token_type: typeof record.token_type === 'string' ? record.token_type : undefined,
    expires_in: typeof record.expires_in === 'number' ? record.expires_in : undefined,
    refresh_token: typeof record.refresh_token === 'string' ? record.refresh_token : undefined,
  };
}

/**
 * OAuth2 resource-owner password grant (RFC 6749 §4.3), one of the flows an
 * OpenCDE auth discovery document can advertise
 * (`resource_owner_password_credentials_grant`). The password is sent to the
 * token endpoint once and never stored; persist only the returned tokens.
 */
export function requestPasswordToken(options: PasswordGrantOptions): Promise<FoundationTokenResponse> {
  return postTokenRequest(options, {
    grant_type: 'password',
    username: options.username,
    password: options.password,
  });
}

/** OAuth2 refresh-token grant (RFC 6749 §6). */
export function refreshAccessToken(options: RefreshGrantOptions): Promise<FoundationTokenResponse> {
  return postTokenRequest(options, {
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
  });
}

/**
 * OAuth2 client-credentials grant (RFC 6749 §4.4). The Foundation API's own
 * `/auth` document does not list this flow (it carries no user identity),
 * but some OpenCDE servers (e.g. OpenProject's BCF service) advertise it
 * anyway for machine-style access using an OAuth application's id and secret
 * instead of a user login.
 */
export function requestClientCredentialsToken(
  options: ClientCredentialsGrantOptions,
): Promise<FoundationTokenResponse> {
  // clientId/clientSecret ride the shared TokenRequestOptions fields, which
  // postTokenRequest already encodes into the form body.
  return postTokenRequest(options, { grant_type: 'client_credentials' });
}

/**
 * OAuth2 authorization-code exchange (RFC 6749 §4.1.3), the second half of
 * the browser sign-in on servers whose `/auth` discovery advertises
 * `authorization_code_grant`. Sends the PKCE verifier when one is given;
 * servers that never saw a challenge ignore it.
 */
export function exchangeAuthorizationCode(
  options: AuthorizationCodeGrantOptions,
): Promise<FoundationTokenResponse> {
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
  };
  if (options.codeVerifier) form.code_verifier = options.codeVerifier;
  return postTokenRequest(options, form);
}

/**
 * OpenCDE Foundation API dynamic client registration (§2.2.3): exchange an
 * app name and redirect URL for a client id (and usually a secret) on
 * servers that advertise `oauth2_dynamic_client_reg_url`, so users never
 * have to pre-register an OAuth application by hand.
 */
export async function registerClient(options: RegisterClientOptions): Promise<RegisteredClient> {
  const fetchFn = resolveFetch(options.fetchFn);
  const response = await fetchFn(options.registrationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: options.clientName,
      client_description: options.clientDescription,
      client_url: options.clientUrl,
      redirect_url: options.redirectUrl,
    }),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new FoundationAuthenticationError('Client registration returned a non-JSON response', {
      status: response.status,
      url: options.registrationUrl,
      namespace: options.errorNamespace,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const record =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (!response.ok) {
    const detail = extractErrorDetail(parsed);
    throw new FoundationAuthenticationError(
      detail ?? `Client registration failed (HTTP ${response.status})`,
      { status: response.status, url: options.registrationUrl, detail, namespace: options.errorNamespace },
    );
  }
  if (typeof record.client_id !== 'string' || record.client_id.length === 0) {
    throw new FoundationAuthenticationError('Client registration response carried no client_id', {
      status: response.status,
      url: options.registrationUrl,
      namespace: options.errorNamespace,
    });
  }
  return {
    client_id: record.client_id,
    client_secret: typeof record.client_secret === 'string' ? record.client_secret : undefined,
  };
}
