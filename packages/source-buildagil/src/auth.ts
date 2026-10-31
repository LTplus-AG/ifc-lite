/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sign-in to buildagil's openCDE API: OAuth 2.0 authorization code with PKCE
 * in a popup. buildagil fronts Microsoft Entra ID (its authorize endpoint
 * redirects there) and issues IFClite a CONFIDENTIAL client, so the code
 * exchange and every refresh carry the client secret. This package never
 * holds it: token requests go to the real token URL through `ctx.fetch`, and
 * a browser host's relay (`/api/buildagil/oauth2/token`) adds the secret.
 */

import {
  NotSignedInError, TokenManager, createAuthorizationRequest, exchangeAuthorizationCode,
  parseAuthorizationCallback, waitForOAuthCallback,
} from '@ifc-lite/oauth-pkce';
import type { PluginContext, SourceAuth, SourceIdentity } from '@ifc-lite/plugin-api';
import { identityFromAccessToken } from './identity.js';
import { BUILDAGIL_API } from './manifest.js';

const AUTHORIZE_ENDPOINT = `${BUILDAGIL_API}/oauth2/authorize`;
export const TOKEN_ENDPOINT = `${BUILDAGIL_API}/oauth2/token`;
/** The API's OAuth scopes (openCDE spec `securitySchemes`): identity, refresh, endpoint access. */
const SCOPES = 'openid offline_access api';
const STORAGE_KEY = 'buildagil:tokens';
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The callback registered with buildagil. It is the viewer's generic OAuth
 * callback page, which hands the result back over a BroadcastChannel.
 */
export const DEFAULT_REDIRECT_PATH = '/oauth/bcf/callback';

/**
 * One `TokenManager` per client id for the page's lifetime: its sign-out
 * protection is per instance, so a refresh on one instance would not see a
 * `clear()` on another and could write tokens back after sign-out. Same
 * reasoning as `@ifc-lite/source-dropbox`'s cache.
 */
const managers = new Map<string, TokenManager>();

export function tokenManager(ctx: PluginContext, clientId: string): TokenManager {
  let manager = managers.get(clientId);
  if (!manager) {
    manager = new TokenManager({ storageKey: STORAGE_KEY, storage: ctx.storage, tokenEndpoint: TOKEN_ENDPOINT, clientId, fetch: ctx.fetch });
    managers.set(clientId, manager);
  }
  return manager;
}

export class BuildagilAuth implements SourceAuth {
  constructor(
    private readonly clientId: string,
    private readonly redirectPath = DEFAULT_REDIRECT_PATH,
    /** Drops whatever the provider cached for the account signing out. */
    private readonly onSignOut: () => void = () => {},
  ) {}

  private requireClientId(): string {
    if (!this.clientId) {
      throw new Error('buildagil sign-in is not configured on this deployment (no client id). Ask the viewer administrator.');
    }
    return this.clientId;
  }

  /** A valid access token, refreshed if needed; NotSignedInError when there is none. */
  accessToken(ctx: PluginContext): Promise<string> {
    return tokenManager(ctx, this.requireClientId()).getValidAccessToken();
  }

  private async current(ctx: PluginContext): Promise<SourceIdentity | null> {
    if (!this.clientId) return null;
    try {
      return identityFromAccessToken(await this.accessToken(ctx));
    } catch (error) {
      if (error instanceof NotSignedInError) return null;
      ctx.log.warn('buildagil: treating as signed out after a token failure', { error: error instanceof Error ? error.name : String(error) });
      return null;
    }
  }

  restore(ctx: PluginContext): Promise<SourceIdentity | null> { return this.current(ctx); }
  getIdentity(ctx: PluginContext): Promise<SourceIdentity | null> { return this.current(ctx); }

  async signIn(ctx: PluginContext): Promise<SourceIdentity> {
    if (typeof window === 'undefined') throw new Error('buildagil sign-in needs a browser window.');
    const clientId = this.requireClientId();
    const redirectUri = `${window.location.origin}${this.redirectPath}`;
    const request = await createAuthorizationRequest({ authorizationEndpoint: AUTHORIZE_ENDPOINT, clientId, redirectUri, scope: SCOPES });
    // Called from a user gesture (the host guarantees it), so not blocked.
    const popup = window.open(request.url, 'ifc-lite-buildagil-signin', 'width=500,height=700');
    if (!popup) throw new Error('The buildagil sign-in popup was blocked by the browser.');
    let callbackUrl: string;
    try {
      // Subscribed before any await: the BroadcastChannel does not buffer.
      // The popup is never polled; under COOP it reads as closed while open.
      callbackUrl = await waitForOAuthCallback({ expectedState: request.state, timeoutMs: POPUP_TIMEOUT_MS, timeoutMessage: 'buildagil sign-in timed out' });
    } catch (error) {
      popup.close();
      throw error;
    }
    const { code } = parseAuthorizationCallback(callbackUrl, { expectedRedirectOrigin: window.location.origin, expectedState: request.state });
    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: TOKEN_ENDPOINT, clientId, redirectUri, code, codeVerifier: request.codeVerifier, fetch: ctx.fetch,
    });
    await tokenManager(ctx, clientId).setTokens(tokens);
    return identityFromAccessToken(tokens.accessToken);
  }

  async signOut(_ctx: PluginContext): Promise<void> {
    this.onSignOut();
    // Every cached manager, so none can write a refreshed token back.
    await Promise.all([...managers.values()].map((manager) => manager.clear()));
    managers.clear();
  }
}
