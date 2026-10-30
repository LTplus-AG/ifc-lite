/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the BCF token relay (`oauth-token-relay.ts`) accepts and what it sends
 * upstream: the two grants, their exact fields, and the one host shape the
 * client secret may be posted to. Pure, so every rejection is testable
 * without a request.
 */

import { bimcollabSpaceOrigin } from '../shared/bimcollab-space.js';

/** BIMcollab's per-space token endpoint path, from `/bcf/2.1/auth`. */
export const BIMCOLLAB_TOKEN_PATH = '/identity/connect/token';

/** Visible ASCII, no spaces: what an IdentityServer code or refresh token is. */
const OPAQUE_TOKEN = /^[\x21-\x7e]{1,4096}$/;
/** RFC 7636 §4.1 code_verifier. */
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * The upstream token URL for a caller-supplied one, rebuilt from its
 * validated host, or null when it is not a BIMcollab space's token endpoint.
 */
export function bimcollabTokenEndpoint(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  if (!url.hostname.endsWith('.bimcollab.com')
    || !bimcollabSpaceOrigin(url.hostname.slice(0, -'.bimcollab.com'.length))) return null;
  if (url.pathname !== BIMCOLLAB_TOKEN_PATH || url.search !== '' || url.hash !== '') return null;
  return `https://${url.hostname}${BIMCOLLAB_TOKEN_PATH}`;
}

export type RelayGrant =
  | { grantType: 'authorization_code'; tokenUrl: string; code: string; redirectUri: string; codeVerifier: string }
  | { grantType: 'refresh_token'; tokenUrl: string; refreshToken: string };

const GRANT_FIELDS: Record<RelayGrant['grantType'], readonly string[]> = {
  authorization_code: ['grantType', 'tokenUrl', 'code', 'redirectUri', 'codeVerifier'],
  refresh_token: ['grantType', 'tokenUrl', 'refreshToken'],
};

/** Parses the request body into a grant, or names what is wrong with it. */
export function parseRelayGrant(
  body: unknown,
  allowedRedirectUris: readonly string[],
): RelayGrant | { problem: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { problem: 'Body must be a JSON object' };
  }
  const record = body as Record<string, unknown>;
  const grantType = record.grantType;
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    return { problem: 'grantType must be authorization_code or refresh_token' };
  }
  const expected = GRANT_FIELDS[grantType];
  const keys = Object.keys(record);
  if (keys.length !== expected.length || !keys.every((key) => expected.includes(key))) {
    return { problem: `A ${grantType} request carries exactly: ${expected.join(', ')}` };
  }
  const tokenUrl = bimcollabTokenEndpoint(record.tokenUrl);
  if (!tokenUrl) {
    return { problem: `tokenUrl must be https://<space>.bimcollab.com${BIMCOLLAB_TOKEN_PATH}` };
  }
  if (grantType === 'refresh_token') {
    const refreshToken = record.refreshToken;
    if (typeof refreshToken !== 'string' || !OPAQUE_TOKEN.test(refreshToken)) {
      return { problem: 'refreshToken is malformed' };
    }
    return { grantType, tokenUrl, refreshToken };
  }
  const { code, redirectUri, codeVerifier } = record;
  if (typeof code !== 'string' || !OPAQUE_TOKEN.test(code)) {
    return { problem: 'code is malformed' };
  }
  if (typeof redirectUri !== 'string' || !allowedRedirectUris.includes(redirectUri)) {
    return { problem: 'redirectUri is not registered for this deployment' };
  }
  if (typeof codeVerifier !== 'string' || !PKCE_VERIFIER.test(codeVerifier)) {
    return { problem: 'codeVerifier must be an RFC 7636 PKCE verifier' };
  }
  return { grantType, tokenUrl, code, redirectUri, codeVerifier };
}

export function upstreamTokenForm(
  grant: RelayGrant,
  client: { readonly clientId: string; readonly clientSecret: string },
): URLSearchParams {
  const form = new URLSearchParams();
  if (grant.grantType === 'authorization_code') {
    form.set('grant_type', 'authorization_code');
    form.set('code', grant.code);
    form.set('redirect_uri', grant.redirectUri);
    form.set('code_verifier', grant.codeVerifier);
  } else {
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', grant.refreshToken);
  }
  form.set('client_id', client.clientId);
  form.set('client_secret', client.clientSecret);
  return form;
}
