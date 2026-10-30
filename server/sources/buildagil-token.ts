/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Token grants for buildagil's openCDE API, whose OAuth app is a
 * CONFIDENTIAL client: the code exchange and every refresh need the client
 * secret, which must never reach the browser.
 *
 * The viewer's `@ifc-lite/source-buildagil` sends standard RFC 6749 form
 * grants to `https://openapi.buildagil.com/oauth2/token`, and the host's relay
 * rewrite delivers them here as `/api/buildagil/oauth2/token`. This accepts
 * exactly the two grants the provider makes, each with an exact field set,
 * adds the secret and posts to the one fixed token URL. Nothing the caller
 * sends picks the upstream, a scope, or another client.
 */

import { readCapped, tokenRelayError } from '../shared/oauth-token-forward.js';

export const BUILDAGIL_TOKEN_URL = 'https://openapi.buildagil.com/oauth2/token';

/** Callbacks registered with buildagil for IFClite's client. */
export const BUILDAGIL_REGISTERED_REDIRECT_URIS: readonly string[] = [
  'https://www.ifclite.com/oauth/bcf/callback',
  'http://localhost:5000/oauth/bcf/callback',
];

/** `error` of the 503 an unconfigured deployment answers. */
export const BUILDAGIL_RELAY_NOT_CONFIGURED = 'relay_not_configured';

/** Visible ASCII, no spaces: what an Entra code or refresh token is. */
const OPAQUE_TOKEN = /^[\x21-\x7e]{1,8192}$/;
/** RFC 7636 §4.1 code_verifier. */
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface BuildagilClientConfig {
  /** Empty means the token route is not configured. */
  readonly clientId: string;
  readonly clientSecret: string;
  readonly allowedRedirectUris: readonly string[];
}

const GRANT_FIELDS: Record<string, readonly string[]> = {
  authorization_code: ['grant_type', 'code', 'redirect_uri', 'client_id', 'code_verifier'],
  refresh_token: ['grant_type', 'refresh_token', 'client_id'],
};

/** The upstream form for a caller's grant, or what is wrong with it. */
export function buildagilTokenForm(text: string, config: BuildagilClientConfig): URLSearchParams | { problem: string } {
  const form = new URLSearchParams(text);
  const keys = [...form.keys()];
  const grantType = form.get('grant_type') ?? '';
  const expected = GRANT_FIELDS[grantType];
  if (!expected) return { problem: 'grant_type must be authorization_code or refresh_token' };
  if (keys.length !== expected.length || !expected.every((key) => form.getAll(key).length === 1)) {
    return { problem: `A ${grantType} request carries exactly: ${expected.join(', ')}` };
  }
  if (form.get('client_id') !== config.clientId) return { problem: 'client_id is not this deployment\'s client' };
  const upstream = new URLSearchParams({ grant_type: grantType });
  if (grantType === 'refresh_token') {
    const refreshToken = form.get('refresh_token') ?? '';
    if (!OPAQUE_TOKEN.test(refreshToken)) return { problem: 'refresh_token is malformed' };
    upstream.set('refresh_token', refreshToken);
  } else {
    const code = form.get('code') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    if (!OPAQUE_TOKEN.test(code)) return { problem: 'code is malformed' };
    if (!config.allowedRedirectUris.includes(redirectUri)) return { problem: 'redirect_uri is not registered for this deployment' };
    if (!PKCE_VERIFIER.test(verifier)) return { problem: 'code_verifier must be an RFC 7636 PKCE verifier' };
    upstream.set('code', code);
    upstream.set('redirect_uri', redirectUri);
    upstream.set('code_verifier', verifier);
  }
  upstream.set('client_id', config.clientId);
  upstream.set('client_secret', config.clientSecret);
  return upstream;
}

function isFormContentType(value: string | null): boolean {
  return (value ?? '').split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

/**
 * Checks a token request before anything is read upstream: method, origin
 * and content type, then the configured client. Returns the upstream form or
 * the error response to send.
 */
export async function readBuildagilGrant(
  request: Request,
  config: BuildagilClientConfig & { readonly allowedOrigins: readonly string[]; readonly maxBodyBytes: number },
): Promise<URLSearchParams | Response> {
  if (request.method !== 'POST') return tokenRelayError(405, 'invalid_request', 'Only POST is accepted', { allow: 'POST' });
  // A form POST is a CORS-simple request a foreign page could send, so the
  // Origin a browser always attaches to it is what keeps those out.
  const origin = request.headers.get('origin');
  if (!origin || !config.allowedOrigins.includes(origin)) return tokenRelayError(403, 'invalid_request', 'Origin not allowed');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') {
    return tokenRelayError(403, 'invalid_request', 'Cross-site requests are not accepted');
  }
  if (!isFormContentType(request.headers.get('content-type'))) {
    return tokenRelayError(415, 'invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }
  if (!config.clientId || !config.clientSecret) {
    return tokenRelayError(503, BUILDAGIL_RELAY_NOT_CONFIGURED,
      'The buildagil token relay is not configured on this deployment (BUILDAGIL_CLIENT_ID, BUILDAGIL_CLIENT_SECRET).');
  }
  const read = await readCapped(request.body, request.headers.get('content-length'), config.maxBodyBytes);
  if (!read.ok) {
    return read.reason === 'too_large'
      ? tokenRelayError(413, 'invalid_request', 'Request body too large')
      : tokenRelayError(400, 'invalid_request', 'Request body is not UTF-8');
  }
  const form = buildagilTokenForm(read.text, config);
  return 'problem' in form ? tokenRelayError(400, 'invalid_request', form.problem) : form;
}
