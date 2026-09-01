/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF server connection state.
 *
 * Persists the server URL, signed-in user, and OAuth2 token set in
 * localStorage (unencrypted, like other BYOK values — revocable, not
 * secret). The password is sent once to the server's token endpoint for the
 * OAuth2 password grant and never stored. `@ifc-lite/bcf-api` is loaded via
 * dynamic import so the connector code stays out of the entry bundle until
 * a user actually connects.
 */

import type { BcfApiClient, BcfProjectDto, BcfProjectFetchResult, BcfSyncProgress } from '@ifc-lite/bcf-api';
import {
  isSameBcfAccount,
  loadBcfServerConfig,
  requireSecureOAuthUrl,
  requireSecureTokenUrl,
  saveBcfServerConfig,
} from './bcf-server-config.js';
import type { BcfServerConfig } from './bcf-server-config.js';
export {
  clearBcfServerConfig,
  loadBcfServerConfig,
  saveBcfServerConfig,
  subscribeBcfServer,
  validateBcfServerUrl,
} from './bcf-server-config.js';
export type { BcfServerConfig } from './bcf-server-config.js';

/** Refresh the access token this many ms before its recorded expiry. */
const EXPIRY_SKEW_MS = 60_000;

function loadApi() {
  return import('@ifc-lite/bcf-api');
}

/**
 * Resolve the signed-in identity for a fresh token set, persist the
 * connection, and hand it back. Shared tail of every sign-in flow.
 */
async function completeSignIn(
  baseUrl: string,
  token: { access_token: string; refresh_token?: string; expires_in?: number },
  appCredentials?: { clientId: string; clientSecret: string },
): Promise<BcfServerConfig> {
  const api = await loadApi();
  const client = new api.BcfApiClient({ baseUrl, getAccessToken: () => token.access_token });
  const user = await client.getCurrentUser();
  const config: BcfServerConfig = {
    serverUrl: baseUrl,
    userId: user.id,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? '',
    tokenExpiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : 0,
    clientId: appCredentials?.clientId ?? '',
    clientSecret: appCredentials?.clientSecret ?? '',
    projectId: '',
    projectName: '',
  };
  saveBcfServerConfig(config);
  return config;
}

/**
 * Sign in with the OAuth2 resource-owner password grant: discover the token
 * endpoint from the server's `/auth` document, exchange the credentials for
 * a token set, resolve the user identity, and persist the connection.
 */
export async function signInToBcfServer(
  serverUrl: string,
  username: string,
  password: string,
): Promise<BcfServerConfig> {
  const api = await loadApi();
  const baseUrl = api.normalizeBcfBaseUrl(serverUrl);
  const anonymous = new api.BcfApiClient({ baseUrl });
  const authInfo = await anonymous.getAuthInfo();
  const token = await api.requestPasswordToken({
    tokenUrl: requireSecureTokenUrl(authInfo.oauth2_token_url),
    username,
    password,
  });
  return completeSignIn(baseUrl, token);
}

/**
 * Sign in with a user-supplied access token (obtained from the server's own
 * UI or OAuth tooling). Works against servers that only offer the
 * authorization-code flow; there is no refresh material, so the session
 * ends when the token expires.
 */
export async function signInWithToken(
  serverUrl: string,
  accessToken: string,
): Promise<BcfServerConfig> {
  const api = await loadApi();
  const baseUrl = api.normalizeBcfBaseUrl(serverUrl);
  return completeSignIn(baseUrl, { access_token: accessToken.trim() });
}

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
  options: { clientId?: string; clientSecret?: string; scope?: string } = {},
): Promise<BcfOAuthPreparation> {
  const api = await loadApi();
  const baseUrl = api.normalizeBcfBaseUrl(serverUrl);
  const authInfo = await new api.BcfApiClient({ baseUrl }).getAuthInfo();
  const tokenUrl = requireSecureTokenUrl(authInfo.oauth2_token_url);
  const authEndpoint = requireSecureOAuthUrl(authInfo.oauth2_auth_url, 'authorization endpoint');

  let clientId = options.clientId?.trim() ?? '';
  let clientSecret = options.clientSecret?.trim() ?? '';
  if (!clientId) {
    if (!authInfo.oauth2_dynamic_client_reg_url) {
      throw new Error(
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
      redirectUrl: bcfOAuthRedirectUri(),
    });
    clientId = registered.client_id;
    clientSecret = registered.client_secret ?? '';
  }

  const { createAuthorizationRequest } = await import('@ifc-lite/oauth-pkce');
  const request = await createAuthorizationRequest({
    authorizationEndpoint: authEndpoint,
    clientId,
    redirectUri: bcfOAuthRedirectUri(),
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
  const redirectUri = bcfOAuthRedirectUri();
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

/**
 * Sign in with an OAuth application's client-credentials grant (e.g. an
 * OpenProject OAuth app). The id/secret are persisted so an expired access
 * token re-grants without user interaction.
 */
export async function signInWithClientCredentials(
  serverUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<BcfServerConfig> {
  const api = await loadApi();
  const baseUrl = api.normalizeBcfBaseUrl(serverUrl);
  const anonymous = new api.BcfApiClient({ baseUrl });
  const authInfo = await anonymous.getAuthInfo();
  const token = await api.requestClientCredentialsToken({
    tokenUrl: requireSecureTokenUrl(authInfo.oauth2_token_url),
    clientId,
    clientSecret,
  });
  return completeSignIn(baseUrl, token, { clientId, clientSecret });
}

/**
 * Single-flight token refresh PER SESSION. One unkeyed slot let a client
 * bound to server B join server A's in-flight refresh and send A's bearer
 * token to B's host — and keying by server alone would still let account
 * B's request on the same server join account A's refresh and run under
 * A's token. Keying by the full session identity keeps every refresh (and
 * its token) to the session that started it while still deduplicating
 * concurrent refreshes of the same session.
 */
const refreshInFlight = new Map<string, Promise<string>>();

/** Identity of the session a refresh belongs to, not just its server. */
function refreshSessionKey(config: BcfServerConfig): string {
  // The NUL escape below cannot appear in a URL, user id, client id, or
  // token, so joined parts cannot collide across field boundaries.
  return [config.serverUrl, config.userId, config.clientId, config.refreshToken].join('\u0000');
}

/** Whether a stored connection has any material to re-authenticate with. */
function canReauthenticate(config: BcfServerConfig): boolean {
  return config.refreshToken.length > 0 || (config.clientId.length > 0 && config.clientSecret.length > 0);
}

/**
 * Whether the stored connection is still the SESSION this refresh started
 * from. Server URL alone is not enough: signing in as a different account
 * on the same server would otherwise get the previous account's refreshed
 * tokens written into its record. The refresh material must be unchanged
 * too, so a re-login as the same user (new refresh token) is not clobbered
 * by the older session's rotation.
 */
function isSameSession(current: BcfServerConfig, config: BcfServerConfig): boolean {
  return isSameBcfAccount(current, config) && current.refreshToken === config.refreshToken;
}

async function refreshStoredToken(config: BcfServerConfig): Promise<string> {
  const key = refreshSessionKey(config);
  const pending = refreshInFlight.get(key);
  if (pending) return pending;
  const started = (async () => {
    const api = await loadApi();
    // Fail before the discovery round-trip when there is nothing to
    // re-authenticate with.
    if (!canReauthenticate(config)) {
      throw new api.BcfAuthenticationError('Session expired — sign in again', {
        status: 401,
        url: config.serverUrl,
      });
    }
    const anonymous = new api.BcfApiClient({ baseUrl: config.serverUrl });
    const authInfo = await anonymous.getAuthInfo();
    const tokenUrl = requireSecureTokenUrl(authInfo.oauth2_token_url);
    // OAuth-app sessions must present the app credentials on the refresh
    // grant too; token servers that never issued a client ignore them.
    const token = config.refreshToken
      ? await api.refreshAccessToken({
          tokenUrl,
          refreshToken: config.refreshToken,
          clientId: config.clientId || undefined,
          clientSecret: config.clientSecret || undefined,
        })
      : await api.requestClientCredentialsToken({
          tokenUrl,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
        });
    // Persist only when the stored connection is still THIS session. If the
    // user disconnected (sign-out is their revocation gesture), switched
    // servers, or switched accounts while the refresh was in flight,
    // re-saving would resurrect or hijack the replacement session. The
    // in-flight caller still gets the fresh token either way.
    const current = loadBcfServerConfig();
    if (current && isSameSession(current, config)) {
      saveBcfServerConfig({
        ...current,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? config.refreshToken,
        tokenExpiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : 0,
      });
    }
    return token.access_token;
  })().finally(() => {
    refreshInFlight.delete(key);
  });
  refreshInFlight.set(key, started);
  return started;
}

/**
 * Client bound to the saved connection. Its token provider transparently
 * refreshes the access token shortly before expiry, and a 401 answer gets
 * one refresh-and-retry (covers servers that omit expires_in); a failed
 * refresh surfaces as a BcfAuthenticationError from the request that
 * needed it.
 */
export async function createConnectedClient(): Promise<BcfApiClient> {
  const api = await loadApi();
  const config = loadBcfServerConfig();
  if (!config) throw new Error('Not connected to a BCF server');
  // Storage can change mid-pull. Only the same account on this server may
  // feed tokens — a different user on the same host would send their bearer
  // token on this client's requests. Token rotation still matches (account
  // identity ignores the refresh token).
  const boundConfig = (): BcfServerConfig => {
    const current = loadBcfServerConfig();
    return current && isSameBcfAccount(current, config) ? current : config;
  };
  return new api.BcfApiClient({
    baseUrl: config.serverUrl,
    getAccessToken: async () => {
      const current = boundConfig();
      const expiring =
        current.tokenExpiresAt > 0 && Date.now() > current.tokenExpiresAt - EXPIRY_SKEW_MS;
      if (expiring && canReauthenticate(current)) {
        return refreshStoredToken(current);
      }
      return current.accessToken;
    },
    fetchFn: async (input, init) => {
      const response = await fetch(input, init);
      if (response.status !== 401) return response;
      const current = boundConfig();
      if (!canReauthenticate(current)) return response;
      let freshToken: string;
      try {
        freshToken = await refreshStoredToken(current);
      } catch (error) {
        console.warn('[bcf-server] token refresh after 401 failed', error);
        return response;
      }
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${freshToken}`);
      return fetch(input, { ...init, headers });
    },
  });
}

export async function listBcfServerProjects(): Promise<BcfProjectDto[]> {
  const client = await createConnectedClient();
  return client.getProjects();
}

/**
 * Pull one project's topics into a `BCFProject` and remember it as the
 * connection's active project.
 */
export async function pullBcfServerProject(
  projectId: string,
  projectName: string,
  onProgress?: (progress: BcfSyncProgress) => void,
): Promise<BcfProjectFetchResult> {
  const api = await loadApi();
  const started = loadBcfServerConfig();
  const client = await createConnectedClient();
  const result = await api.fetchProjectAsBCF(client, projectId, { onProgress });
  if (!result.project.name) result.project.name = projectName;
  const current = loadBcfServerConfig();
  if (started && current && isSameBcfAccount(current, started)) {
    saveBcfServerConfig({ ...current, projectId, projectName });
  }
  return result;
}
