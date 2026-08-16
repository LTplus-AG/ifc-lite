/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  NotSignedInError,
  TokenManager,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  parseAuthorizationCallback,
  waitForOAuthCallback,
} from '@ifc-lite/oauth-pkce';
import type { PluginContext, SourceAuth, SourceIdentity } from '@ifc-lite/plugin-api';

import { BrowserGraphApiClient } from './http-client.js';

const AUTHORIZE_ENDPOINT = (tenant: string) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
const TOKEN_ENDPOINT = (tenant: string) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

/**
 * `Files.Read` is the least-privileged delegated scope for reading OneDrive/
 * SharePoint file content (Microsoft Graph docs, "Download driveItem content",
 * permissions table: Delegated work-or-school AND personal accounts both list
 * `Files.Read` as least-privileged) — needs no admin consent.
 *
 * `offline_access` is required *in addition*, not implied by any other scope:
 * per the Microsoft identity platform's v2.0 auth-code-flow docs ("Successful
 * response" under "Redeem a code for an access token"), the token response's
 * `refresh_token` field is documented as "Only provided if offline_access
 * scope was requested." Without it, every session would need an interactive
 * sign-in again the moment the short-lived access token expired.
 *
 * Note even with `offline_access`: a SPA redirect URI's refresh token is
 * capped at a 24-hour lifetime by Microsoft regardless of how long the
 * *access* token would otherwise be refreshable for (same doc, "Refresh the
 * access token" section) — re-authentication is required at least once a
 * day, though normally silent via the identity platform's own session.
 */
const SCOPES = 'offline_access https://graph.microsoft.com/Files.Read';

const STORAGE_KEY = 'msgraph:tokens';
const DEFAULT_TENANT = 'common';

/** Path the Azure AD app registration's redirect URI must point at (appended
 * to this app's own origin). See the package README for the exact value the
 * app registration needs. */
export const REDIRECT_PATH = '/oauth/msgraph/callback';

const POPUP_TIMEOUT_MS = 5 * 60 * 1000;

export async function requireClientId(ctx: PluginContext): Promise<string> {
  const clientId = await ctx.getPreference('clientId');
  if (!clientId) {
    throw new Error(
      'Microsoft Graph provider is not configured: no Azure AD application (client) ID. ' +
        'Set the "clientId" preference — see the @ifc-lite/source-msgraph README for what to register.',
    );
  }
  return clientId;
}

export async function getTenant(ctx: PluginContext): Promise<string> {
  const tenant = await ctx.getPreference('tenant');
  return tenant && tenant.length > 0 ? tenant : DEFAULT_TENANT;
}

/** Shared with `provider.ts`, which needs the same token manager to mint an
 *  access token for plain Graph API calls (listing, download metadata, ...) —
 *  a single definition keeps the storage key and token endpoint from drifting
 *  between the two call sites. */
export function createTokenManager(ctx: PluginContext, clientId: string, tenant: string): TokenManager {
  return new TokenManager({
    storageKey: STORAGE_KEY,
    // `ctx.storage` (`KeyValueStore`) is structurally compatible with
    // `TokenStorage` — see the `@ifc-lite/oauth-pkce` README's storage
    // trade-off section. It's already namespaced per-provider by the host,
    // same as it is for Dalux's API key, so a single fixed storage key is
    // enough (no per-tenant/per-client namespacing needed on top).
    storage: ctx.storage,
    tokenEndpoint: TOKEN_ENDPOINT(tenant),
    clientId,
    fetch: ctx.fetch,
  });
}

/** Reads `id`/`displayName`/`mail` off `/me`. Deliberately a live Graph call
 *  rather than decoding the access token: this package's `TokenSet` (from
 *  `@ifc-lite/oauth-pkce`) carries only `access_token`/`refresh_token`/
 *  `expires_in`/`scope`/`token_type` — no `id_token` — so there is nothing to
 *  decode client-side, and an opaque access token can't be read at all. */
async function fetchIdentity(ctx: PluginContext, accessToken: string): Promise<SourceIdentity> {
  const client = new BrowserGraphApiClient(accessToken, ctx);
  const raw = await client.get('/me', { $select: 'id,displayName,mail,userPrincipalName' });
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Microsoft Graph /me returned an unexpected response');
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : undefined;
  if (!id) throw new Error('Microsoft Graph /me response is missing "id"');

  const email =
    typeof record.mail === 'string' && record.mail.length > 0
      ? record.mail
      : typeof record.userPrincipalName === 'string'
        ? record.userPrincipalName
        : undefined;

  return {
    id,
    displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
    email,
  };
}

/**
 * Restores or fetches the current identity without ever throwing — used by
 * both `restore()` (which must be silent per the `SourceAuth` contract) and
 * `getIdentity()` (which "must not perform interactive work" but may still
 * refresh a token over the network, since that's not interactive).
 */
async function currentIdentity(ctx: PluginContext): Promise<SourceIdentity | null> {
  const clientId = await ctx.getPreference('clientId');
  if (!clientId) return null;
  const tenant = await getTenant(ctx);
  const manager = createTokenManager(ctx, clientId, tenant);

  try {
    const accessToken = await manager.getValidAccessToken();
    return await fetchIdentity(ctx, accessToken);
  } catch (err) {
    if (err instanceof NotSignedInError) return null;
    ctx.log.warn('Microsoft Graph: treating as signed out after a restore/identity failure', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export const msGraphAuth: SourceAuth = {
  async restore(ctx: PluginContext): Promise<SourceIdentity | null> {
    return currentIdentity(ctx);
  },

  async signIn(ctx: PluginContext): Promise<SourceIdentity> {
    if (typeof window === 'undefined') {
      throw new Error('Microsoft sign-in requires a browser (window.open is unavailable in this environment)');
    }

    const clientId = await requireClientId(ctx);
    const tenant = await getTenant(ctx);
    const redirectUri = `${window.location.origin}${REDIRECT_PATH}`;

    const authRequest = await createAuthorizationRequest({
      authorizationEndpoint: AUTHORIZE_ENDPOINT(tenant),
      clientId,
      redirectUri,
      scope: SCOPES,
      // Always shows the account picker rather than silently reusing
      // whichever Microsoft account happens to have an active browser
      // session — signing into ifc-lite should not depend on which tab was
      // opened last.
      extraParams: { prompt: 'select_account' },
    });

    // `signIn` is documented as "called only from a user gesture" — the host
    // guarantees this, which is what keeps `window.open` here from being
    // blocked as an unsolicited popup.
    const popup = window.open(authRequest.url, 'ifc-lite-msgraph-signin', 'width=500,height=700');
    if (!popup) {
      throw new Error('Microsoft sign-in popup was blocked by the browser');
    }

    // Subscribed here, synchronously after the popup opens and before any
    // `await`, because `BroadcastChannel` does not buffer: a message posted
    // before this listener exists would be lost.
    //
    // The popup itself is deliberately never inspected. Under this app's
    // `Cross-Origin-Opener-Policy: same-origin`, `popup.closed` is `true` and
    // `popup.location` throws for a cross-origin popup even while it is open
    // and working, so the usual poll loop rejects every sign-in as
    // "cancelled" on its first tick. `@ifc-lite/oauth-pkce`'s
    // `callback-channel.ts` documents the probe. Cancellation therefore falls
    // back to the timeout.
    let callbackUrl: string;
    try {
      callbackUrl = await waitForOAuthCallback({
        expectedState: authRequest.state,
        timeoutMs: POPUP_TIMEOUT_MS,
        timeoutMessage: 'Microsoft sign-in timed out',
      });
    } catch (err) {
      // Best effort: also inert on a severed popup, but harmless, and it does
      // close the window in a browser that has not cut the opener link.
      popup.close();
      throw err;
    }

    const callback = parseAuthorizationCallback(callbackUrl, {
      expectedRedirectOrigin: window.location.origin,
      expectedState: authRequest.state,
    });

    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: TOKEN_ENDPOINT(tenant),
      clientId,
      redirectUri,
      code: callback.code,
      codeVerifier: authRequest.codeVerifier,
      fetch: ctx.fetch,
    });

    const manager = createTokenManager(ctx, clientId, tenant);
    await manager.setTokens(tokens);

    return fetchIdentity(ctx, tokens.accessToken);
  },

  async signOut(ctx: PluginContext): Promise<void> {
    const clientId = await ctx.getPreference('clientId');
    const tenant = await getTenant(ctx);
    // A client id is needed to build the `TokenManager` (its storage key is
    // fixed, but `TokenManagerConfig` still requires one), but signing out
    // with no client id configured is still meaningful — there may be a
    // stale token set left over from before the preference was cleared — so
    // fall back to a placeholder rather than no-op. `TokenManager.clear()`
    // never uses `clientId` itself, only `storageKey`.
    const manager = createTokenManager(ctx, clientId ?? 'unconfigured', tenant);
    await manager.clear();
  },

  async getIdentity(ctx: PluginContext): Promise<SourceIdentity | null> {
    return currentIdentity(ctx);
  },
};
