/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// OIDC authorization code + PKCE, with endpoint DISCOVERY.
//
// Every other provider in this repo hard-codes its authorization and token
// endpoints, because each one talks to exactly one vendor. This one is
// generic: the endpoints belong to whichever identity provider the deployment
// runs, so they are read from the issuer's
// `/.well-known/openid-configuration` (OpenID Connect Discovery 1.0 §4) and
// cached. A deployment therefore configures an ISSUER, not three URLs it
// could get inconsistent with each other.
// ============================================================================

import {
  NotSignedInError,
  TokenManager,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  parseAuthorizationCallback,
  waitForOAuthCallback,
} from '@ifc-lite/oauth-pkce';
import type { PluginContext, SourceAuth, SourceIdentity } from '@ifc-lite/plugin-api';

import { CommitHttpError } from './errors.js';

/** Path the identity provider's registered redirect URI must point at. */
export const REDIRECT_PATH = '/oauth/commit-http/callback';

const SCOPES = 'openid profile email offline_access';
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;

export interface ResolvedConfig {
  readonly baseUrl: string;
  readonly issuer: string;
  readonly clientId: string;
}

/** Reads and validates the three preferences every call needs. */
export async function resolveConfig(ctx: PluginContext): Promise<ResolvedConfig> {
  const baseUrl = (await ctx.getPreference('baseUrl'))?.trim();
  const clientId = (await ctx.getPreference('clientId'))?.trim();
  if (!baseUrl) {
    throw new CommitHttpError('invalid', 'Commit service is not configured: set the "baseUrl" preference.', 0);
  }
  if (!clientId) {
    throw new CommitHttpError('invalid', 'Commit service is not configured: set the "clientId" preference.', 0);
  }
  const issuer = (await ctx.getPreference('issuer'))?.trim() || baseUrl;
  return { baseUrl, issuer, clientId };
}

interface OidcEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly userinfoEndpoint?: string;
}

/**
 * Discovery documents are immutable enough to cache for a page's lifetime and
 * expensive enough (one round trip before every sign-in) to be worth it.
 * Keyed by issuer so two configured deployments cannot read each other's.
 */
const discoveryCache = new Map<string, Promise<OidcEndpoints>>();

/** Drops the discovery cache. Exported for tests, and used on sign-out. */
export function resetDiscoveryCache(): void {
  discoveryCache.clear();
}

function requireString(document: Record<string, unknown>, field: string, issuer: string): string {
  const value = document[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CommitHttpError(
      'invalid',
      `OIDC discovery at ${issuer} returned no usable "${field}"`,
      0,
    );
  }
  return value;
}

async function discoverEndpoints(ctx: PluginContext, issuer: string): Promise<OidcEndpoints> {
  const cached = discoveryCache.get(issuer);
  if (cached) return cached;

  const pending = (async (): Promise<OidcEndpoints> => {
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const response = await ctx.fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new CommitHttpError('unavailable', `OIDC discovery failed: ${url} responded ${response.status}`, response.status);
    }
    const document = (await response.json()) as Record<string, unknown>;
    const userinfoEndpoint = document.userinfo_endpoint;
    return {
      authorizationEndpoint: requireString(document, 'authorization_endpoint', issuer),
      tokenEndpoint: requireString(document, 'token_endpoint', issuer),
      ...(typeof userinfoEndpoint === 'string' ? { userinfoEndpoint } : {}),
    };
  })();

  // Cached BEFORE the await so concurrent sign-ins share one round trip;
  // evicted on failure so a transient outage is not remembered forever.
  discoveryCache.set(issuer, pending);
  pending.catch(() => discoveryCache.delete(issuer));
  return pending;
}

/**
 * One `TokenManager` per (issuer, clientId), for the page's lifetime.
 *
 * Same reasoning as `source-dropbox`'s cache, and the same bug if it is
 * skipped: `TokenManager`'s "did someone sign out while I was refreshing"
 * check is per-instance, so a fresh manager per call lets an in-flight
 * refresh write a valid token set back AFTER sign-out deleted it.
 */
const managerCache = new Map<string, TokenManager>();

function managerKey(config: ResolvedConfig): string {
  return `${config.issuer}|${config.clientId}`;
}

async function getTokenManager(ctx: PluginContext, config: ResolvedConfig): Promise<TokenManager> {
  const key = managerKey(config);
  const cached = managerCache.get(key);
  if (cached) return cached;

  const endpoints = await discoverEndpoints(ctx, config.issuer);
  // Re-check: another caller may have populated the cache while discovery
  // was in flight, and two managers for one token set is the race above.
  const raced = managerCache.get(key);
  if (raced) return raced;

  const manager = new TokenManager({
    storageKey: `commit-http:${key}`,
    storage: ctx.storage,
    tokenEndpoint: endpoints.tokenEndpoint,
    clientId: config.clientId,
    fetch: ctx.fetch,
  });
  managerCache.set(key, manager);
  return manager;
}

/** An access token for a data-plane call, refreshing transparently. */
export async function accessTokenFor(ctx: PluginContext, config: ResolvedConfig): Promise<string> {
  const manager = await getTokenManager(ctx, config);
  return manager.getValidAccessToken();
}

/**
 * Identity from the userinfo endpoint.
 *
 * Deliberately a live call rather than decoding the `id_token`: verifying an
 * ID token properly needs the issuer's JWKS and signature validation, and an
 * UNVERIFIED decode is worse than no decode — it would render an identity
 * line from a token nobody checked.
 */
async function fetchIdentity(ctx: PluginContext, config: ResolvedConfig, accessToken: string): Promise<SourceIdentity> {
  const endpoints = await discoverEndpoints(ctx, config.issuer);
  if (!endpoints.userinfoEndpoint) {
    return { id: config.clientId, displayName: config.baseUrl };
  }
  const response = await ctx.fetch(endpoints.userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new CommitHttpError('forbidden', `userinfo responded ${response.status}`, response.status);
  }
  const claims = (await response.json()) as Record<string, unknown>;
  const sub = typeof claims.sub === 'string' ? claims.sub : config.clientId;
  return {
    id: sub,
    ...(typeof claims.name === 'string' ? { displayName: claims.name } : {}),
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
  };
}

/** Never throws — shared by `restore` (must be silent) and `getIdentity`. */
async function currentIdentity(ctx: PluginContext): Promise<SourceIdentity | null> {
  try {
    const config = await resolveConfig(ctx);
    const manager = await getTokenManager(ctx, config);
    return await fetchIdentity(ctx, config, await manager.getValidAccessToken());
  } catch (error) {
    if (error instanceof NotSignedInError) return null;
    ctx.log.warn('commit-http: treating as signed out after a restore/identity failure', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export const commitHttpAuth: SourceAuth = {
  async restore(ctx) {
    return currentIdentity(ctx);
  },

  async signIn(ctx) {
    if (typeof window === 'undefined') {
      throw new Error('Commit service sign-in requires a browser (window.open is unavailable in this environment)');
    }
    const config = await resolveConfig(ctx);
    const endpoints = await discoverEndpoints(ctx, config.issuer);
    const redirectUri = `${window.location.origin}${REDIRECT_PATH}`;

    const request = await createAuthorizationRequest({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      clientId: config.clientId,
      redirectUri,
      scope: SCOPES,
    });

    const popup = window.open(request.url, 'ifc-lite-commit-signin', 'width=500,height=700');
    if (!popup) throw new Error('Commit service sign-in popup was blocked by the browser');

    let callbackUrl: string;
    try {
      // Subscribed synchronously after `window.open` and before any other
      // await: `BroadcastChannel` does not buffer, so a message posted before
      // the listener exists is lost.
      callbackUrl = await waitForOAuthCallback({
        expectedState: request.state,
        timeoutMs: POPUP_TIMEOUT_MS,
        timeoutMessage: 'Commit service sign-in timed out',
      });
    } catch (error) {
      popup.close();
      throw error;
    }

    const callback = parseAuthorizationCallback(callbackUrl, {
      expectedRedirectOrigin: window.location.origin,
      expectedState: request.state,
    });
    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: endpoints.tokenEndpoint,
      clientId: config.clientId,
      redirectUri,
      code: callback.code,
      codeVerifier: request.codeVerifier,
      fetch: ctx.fetch,
    });

    const manager = await getTokenManager(ctx, config);
    await manager.setTokens(tokens);
    return fetchIdentity(ctx, config, tokens.accessToken);
  },

  async signOut(ctx) {
    // Clear EVERY cached manager, not just the configured one: `clear()` is
    // what disarms an in-flight refresh, and that check is per-instance, so a
    // manager left cached under a since-edited preference could write a token
    // set back after this sign-out deleted it.
    await Promise.all([...managerCache.values()].map((manager) => manager.clear()));
    managerCache.clear();
    resetDiscoveryCache();
    ctx.log.debug('commit-http: signed out');
  },

  async getIdentity(ctx) {
    return currentIdentity(ctx);
  },
};

/** Test seam: drops the per-page manager cache without signing out. */
export function resetTokenManagerCache(): void {
  managerCache.clear();
}
