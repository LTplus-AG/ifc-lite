/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser OAuth sign-in to a BCF server: authorization code + PKCE through
 * a popup, with the client id coming from the caller (a vendor-issued app
 * the deployment holds, or one the user typed) or minted on the spot where
 * the server offers dynamic client registration. `prepareBcfOAuth` builds
 * the authorization URL; `completeBcfOAuth` exchanges the code the popup
 * brought back and persists the session. Everything else about the
 * connection lives in `bcf-server.ts`, which re-exports this module.
 */

import { requireSecureOAuthUrl, requireSecureTokenUrl } from './bcf-server-config.js';
import type { BcfServerConfig } from './bcf-server-config.js';
import { completeSignIn, loadApi } from './bcf-server-session.js';

/** Path the popup returns to; must match what OAuth apps register. */
export const BCF_OAUTH_REDIRECT_PATH = '/oauth/bcf/callback';

/** Absolute redirect URI for this deployment, shown to users for app registration. */
export function bcfOAuthRedirectUri(): string {
  return `${window.location.origin}${BCF_OAUTH_REDIRECT_PATH}`;
}

/** Everything one browser sign-in attempt needs across the popup round-trip. */
export interface BcfOAuthPreparation {
  serverUrl: string;
  tokenUrl: string;
  /** Full authorization URL to navigate the popup to. */
  authorizeUrl: string;
  state: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  /** Redirect URI the authorization request named; the exchange must repeat it. */
  redirectUri: string;
}

export interface PrepareBcfOAuthOptions {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  /**
   * Redirect URI registered with the vendor when it is not this origin's
   * `bcfOAuthRedirectUri()`. Must still be on this origin: the callback page
   * hands the result back over a BroadcastChannel, which is origin-scoped,
   * so a redirect elsewhere would land where nobody is listening.
   */
  redirectUri?: string;
  /**
   * What to tell the user when no client id is available and the server
   * offers no dynamic registration. The default asks them to register an
   * app with the vendor, which is wrong advice for vendors that only issue
   * ids to application developers.
   */
  missingClientIdMessage?: string;
}

/**
 * First half of the browser OAuth sign-in: discover the server's endpoints,
 * resolve a client id — the caller's own, or one minted on the spot where
 * the server offers dynamic client registration — and build the
 * authorization URL (with PKCE; servers that ignore the challenge still
 * accept the exchange).
 */
export async function prepareBcfOAuth(
  serverUrl: string,
  options: PrepareBcfOAuthOptions = {},
): Promise<BcfOAuthPreparation> {
  const redirectUri = options.redirectUri?.trim() || bcfOAuthRedirectUri();
  // Checked before any network work: a mis-registered redirect would
  // otherwise send the user through the vendor's login only to strand them
  // on the callback page, and the opener would wait out its timeout.
  const redirectOrigin = new URL(redirectUri).origin;
  if (redirectOrigin !== window.location.origin) {
    throw new Error(
      `This sign-in returns to ${redirectOrigin}, not to ${window.location.origin}. Open the viewer at ${redirectOrigin} to sign in.`,
    );
  }

  const api = await loadApi();
  const { baseUrl, authInfo } = await api.discoverBcfService({ baseUrl: serverUrl });
  const tokenUrl = requireSecureTokenUrl(authInfo.oauth2_token_url);
  const authEndpoint = requireSecureOAuthUrl(authInfo.oauth2_auth_url, 'authorization endpoint');

  let clientId = options.clientId?.trim() ?? '';
  let clientSecret = options.clientSecret?.trim() ?? '';
  if (!clientId) {
    if (!authInfo.oauth2_dynamic_client_reg_url) {
      throw new Error(
        options.missingClientIdMessage ??
          'This server needs a Client ID: register an OAuth application with the vendor and enter its client id.',
      );
    }
    const registered = await api.registerBcfClient({
      registrationUrl: requireSecureOAuthUrl(
        authInfo.oauth2_dynamic_client_reg_url,
        'client registration endpoint',
      ),
      clientName: 'IFClite viewer',
      clientUrl: window.location.origin,
      redirectUrl: redirectUri,
    });
    clientId = registered.client_id;
    clientSecret = registered.client_secret ?? '';
  }

  const { createAuthorizationRequest } = await import('@ifc-lite/oauth-pkce');
  const request = await createAuthorizationRequest({
    authorizationEndpoint: authEndpoint,
    clientId,
    redirectUri,
    scope: options.scope,
  });
  return {
    serverUrl: baseUrl,
    tokenUrl,
    authorizeUrl: request.url,
    state: request.state,
    codeVerifier: request.codeVerifier,
    clientId,
    clientSecret,
    redirectUri,
  };
}

/**
 * Second half of the browser OAuth sign-in: validate the popup's callback
 * URL (origin, provider error, state, code), exchange the code, resolve
 * the identity, and persist the session. The client id/secret are stored
 * so token refreshes can authenticate.
 */
export async function completeBcfOAuth(
  preparation: BcfOAuthPreparation,
  callbackUrl: string,
): Promise<BcfServerConfig> {
  const api = await loadApi();
  const { parseAuthorizationCallback } = await import('@ifc-lite/oauth-pkce');
  const { redirectUri } = preparation;
  const { code } = parseAuthorizationCallback(callbackUrl, {
    expectedRedirectOrigin: new URL(redirectUri).origin,
    expectedState: preparation.state,
  });
  const token = await api.exchangeAuthorizationCode({
    tokenUrl: preparation.tokenUrl,
    code,
    redirectUri,
    codeVerifier: preparation.codeVerifier,
    clientId: preparation.clientId,
    clientSecret: preparation.clientSecret || undefined,
  });
  return completeSignIn(preparation.serverUrl, token, {
    clientId: preparation.clientId,
    clientSecret: preparation.clientSecret,
  });
}
