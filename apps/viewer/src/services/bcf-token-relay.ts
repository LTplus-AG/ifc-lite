/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser side of the server-held token relay for vendor apps that are OAuth
 * CONFIDENTIAL clients (#4919; the relay is `server/bcf/oauth-token-relay.ts`,
 * served at `/api/bcf/oauth/token`). The vendor's token endpoint needs the
 * client secret on the code exchange and on every refresh, and the secret
 * must never reach the browser, so both grants go to the relay, which adds
 * it. The authorization request itself is unchanged: PKCE in the popup.
 */

import type { FetchLike } from '@ifc-lite/bcf-api';

/**
 * `error` the relay answers (503) when its deployment holds no client
 * credentials: `RELAY_NOT_CONFIGURED` in `server/bcf/oauth-token-relay.ts`.
 */
const RELAY_NOT_CONFIGURED = 'relay_not_configured';

/**
 * Absolute URL for a configured relay path. It must be on this origin: the
 * relay receives the authorization code and the refresh token, and the
 * relay itself only answers same-origin callers.
 */
export function resolveTokenRelayUrl(relay: string): string {
  const url = new URL(relay, window.location.origin);
  if (url.origin !== window.location.origin) {
    throw new Error(
      `The BCF token relay must be on this origin (${window.location.origin}), not ${url.origin}.`,
    );
  }
  return url.toString();
}

/**
 * A `fetchFn` for `@ifc-lite/bcf-api`'s token grants that sends them to the
 * relay instead of the vendor's token URL. The grant's form body is restated
 * as the relay's JSON request; the relay answers in the token endpoint's own
 * response format, so the grant's response parsing and error mapping apply
 * unchanged.
 */
export function relayTokenFetch(relay: string): FetchLike {
  const relayUrl = resolveTokenRelayUrl(relay);
  return (tokenUrl, init) => {
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const grantType = form.get('grant_type');
    let payload: Record<string, string>;
    if (grantType === 'authorization_code') {
      payload = {
        grantType,
        tokenUrl,
        code: form.get('code') ?? '',
        redirectUri: form.get('redirect_uri') ?? '',
        codeVerifier: form.get('code_verifier') ?? '',
      };
    } else if (grantType === 'refresh_token') {
      payload = { grantType, tokenUrl, refreshToken: form.get('refresh_token') ?? '' };
    } else {
      return Promise.reject(
        new Error(`The BCF token relay does not carry the ${grantType ?? 'unnamed'} grant`),
      );
    }
    return fetch(relayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
      redirect: 'error',
    });
  };
}

function isRelayNotConfigured(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, errorCode } = error as { status?: unknown; errorCode?: unknown };
  return status === 503 && errorCode === RELAY_NOT_CONFIGURED;
}

/**
 * Run one token grant through the relay when one is configured, else
 * directly. A deployment whose relay holds no credentials answers 503
 * before contacting the vendor, so the code (or refresh token) is still
 * unspent and the grant falls back to the direct, public-client request it
 * would have made without a relay. Returns the relay that actually produced
 * the token ('' = direct), for the session to refresh the same way.
 */
export async function withTokenRelay<T>(
  relay: string,
  throughRelay: (fetchFn: FetchLike) => Promise<T>,
  direct: () => Promise<T>,
): Promise<{ result: T; tokenRelay: string }> {
  if (!relay) return { result: await direct(), tokenRelay: '' };
  try {
    return { result: await throughRelay(relayTokenFetch(relay)), tokenRelay: relay };
  } catch (error) {
    if (!isRelayNotConfigured(error)) throw error;
    console.warn('[bcf-server] token relay is not configured on this deployment; using the token endpoint directly', error);
    return { result: await direct(), tokenRelay: '' };
  }
}
