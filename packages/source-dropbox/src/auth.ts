/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  NotSignedInError,
  TokenManager,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  parseAuthorizationCallback,
} from '@ifc-lite/oauth-pkce';
import type { PluginContext, SourceAuth, SourceIdentity } from '@ifc-lite/plugin-api';

import { BrowserDropboxApiClient } from './http-client.js';
import { decodeCurrentAccount } from './dropbox-types.js';

// Endpoints per Dropbox's own OAuth guide (`developers.dropbox.com/oauth-guide`,
// "Implementing OAuth" / "PKCE", checked 2026-08-15): the authorization
// endpoint is `https://www.dropbox.com/oauth2/authorize`, the token endpoint
// is `https://www.dropbox.com/oauth2/token` — not `api.dropboxapi.com`, which
// hosts only the data-plane RPC endpoints this package's `http-client.ts` calls.
const AUTHORIZE_ENDPOINT = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://www.dropbox.com/oauth2/token';

/**
 * Least-privileged scopes for read-only browsing and download of an IFC
 * model store: `files.metadata.read` (list folders/files, revisions,
 * search), `files.content.read` (download bytes), `account_info.read`
 * (the identity line `fetchIdentity` below renders). Per Dropbox's own docs
 * on scoped apps (`dropbox.tech/developers/customizing-scopes-in-oauth-flow`
 * and the App Console's Permissions tab, checked 2026-08-15), these must
 * also be enabled on the app registration itself — see the package README.
 *
 * PKCE is Dropbox's own explicitly recommended flow for a browser app with
 * no way to keep a `client_secret` confidential (`developers.dropbox.com/oauth-guide`,
 * "PKCE" section, checked 2026-08-15) — this package never sends one.
 */
const SCOPES = 'account_info.read files.metadata.read files.content.read';

const STORAGE_KEY = 'dropbox:tokens';

/** Path the Dropbox app's redirect URI must point at (appended to this app's
 * own origin). See the package README for the exact value the app
 * registration needs. */
export const REDIRECT_PATH = '/oauth/dropbox/callback';

const POPUP_POLL_MS = 250;
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;

export async function requireClientId(ctx: PluginContext): Promise<string> {
  const clientId = await ctx.getPreference('clientId');
  if (!clientId) {
    throw new Error(
      'Dropbox provider is not configured: no app key. Set the "clientId" preference — ' +
        'see the @ifc-lite/source-dropbox README for what to register.',
    );
  }
  return clientId;
}

/** Shared with `provider.ts`, which needs the same token manager to mint an
 *  access token for plain API calls (listing, download, ...) — a single
 *  definition keeps the storage key and token endpoint from drifting between
 *  the two call sites. */
export function createTokenManager(ctx: PluginContext, clientId: string): TokenManager {
  return new TokenManager({
    storageKey: STORAGE_KEY,
    // `ctx.storage` (`KeyValueStore`) is structurally compatible with
    // `TokenStorage` — see the `@ifc-lite/oauth-pkce` README's storage
    // trade-off section. Already namespaced per-provider by the host, so a
    // single fixed storage key is enough.
    storage: ctx.storage,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId,
    fetch: ctx.fetch,
  });
}

/** Reads `account_id`/`name.display_name`/`email` off `/2/users/get_current_account`.
 *  Deliberately a live API call rather than decoding the access token: this
 *  package's `TokenSet` (from `@ifc-lite/oauth-pkce`) carries only
 *  `access_token`/`refresh_token`/`expires_in`/`scope`/`token_type` — no
 *  `id_token` — so there is nothing to decode client-side. */
async function fetchIdentity(ctx: PluginContext, accessToken: string): Promise<SourceIdentity> {
  const client = new BrowserDropboxApiClient(accessToken, ctx);
  const raw = await client.rpc('/users/get_current_account', null);
  const account = decodeCurrentAccount(raw);
  return { id: account.account_id, displayName: account.displayName, email: account.email };
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
  const manager = createTokenManager(ctx, clientId);

  try {
    const accessToken = await manager.getValidAccessToken();
    return await fetchIdentity(ctx, accessToken);
  } catch (err) {
    if (err instanceof NotSignedInError) return null;
    ctx.log.warn('Dropbox: treating as signed out after a restore/identity failure', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Polls a popup for a same-origin redirect. Cross-origin `popup.location`
 * access throws a `SecurityError` for as long as the popup is still on
 * `dropbox.com`; that's expected and simply means "keep polling" rather than
 * a real failure — only once the popup navigates back to this app's own
 * origin does reading its URL succeed. Mirrors `source-msgraph`'s
 * `waitForPopupRedirect`.
 */
function waitForPopupRedirect(popup: Window, redirectOrigin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (popup.closed) {
        clearInterval(interval);
        reject(new Error('Dropbox sign-in was cancelled (the popup was closed)'));
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        popup.close();
        reject(new Error('Dropbox sign-in timed out'));
        return;
      }
      let href: string | undefined;
      try {
        href = popup.location.href;
      } catch {
        return; // Still cross-origin on dropbox.com — keep polling.
      }
      if (href.startsWith(redirectOrigin)) {
        clearInterval(interval);
        popup.close();
        resolve(href);
      }
    }, POPUP_POLL_MS);
  });
}

export const dropboxAuth: SourceAuth = {
  async restore(ctx: PluginContext): Promise<SourceIdentity | null> {
    return currentIdentity(ctx);
  },

  async signIn(ctx: PluginContext): Promise<SourceIdentity> {
    if (typeof window === 'undefined') {
      throw new Error('Dropbox sign-in requires a browser (window.open is unavailable in this environment)');
    }

    const clientId = await requireClientId(ctx);
    const redirectUri = `${window.location.origin}${REDIRECT_PATH}`;

    const authRequest = await createAuthorizationRequest({
      authorizationEndpoint: AUTHORIZE_ENDPOINT,
      clientId,
      redirectUri,
      scope: SCOPES,
      extraParams: {
        // Per Dropbox's OAuth guide (`developers.dropbox.com/oauth-guide`,
        // "Include the following query parameters as part of the
        // authorization request in order to receive a refresh token",
        // checked 2026-08-15): `token_access_type=offline` on the
        // *authorization* request (not the token request) is what makes the
        // token endpoint's response include a `refresh_token` at all —
        // omitting it silently yields a short-lived-only access token that
        // expires with no way to renew it short of interactive sign-in
        // again. This is the Dropbox analogue of `offline_access` in
        // `source-msgraph`'s `SCOPES`, but expressed as an authorize-time
        // flag rather than a requested scope.
        token_access_type: 'offline',
      },
    });

    // `signIn` is documented as "called only from a user gesture" — the host
    // guarantees this, which is what keeps `window.open` here from being
    // blocked as an unsolicited popup.
    const popup = window.open(authRequest.url, 'ifc-lite-dropbox-signin', 'width=500,height=700');
    if (!popup) {
      throw new Error('Dropbox sign-in popup was blocked by the browser');
    }

    let callbackUrl: string;
    try {
      callbackUrl = await waitForPopupRedirect(popup, window.location.origin, POPUP_TIMEOUT_MS);
    } catch (err) {
      if (!popup.closed) popup.close();
      throw err;
    }

    const callback = parseAuthorizationCallback(callbackUrl, {
      expectedRedirectOrigin: window.location.origin,
      expectedState: authRequest.state,
    });

    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId,
      redirectUri,
      code: callback.code,
      codeVerifier: authRequest.codeVerifier,
      fetch: ctx.fetch,
    });

    const manager = createTokenManager(ctx, clientId);
    await manager.setTokens(tokens);

    return fetchIdentity(ctx, tokens.accessToken);
  },

  async signOut(ctx: PluginContext): Promise<void> {
    const clientId = await ctx.getPreference('clientId');
    // A client id is needed to build the `TokenManager` (its storage key is
    // fixed, but `TokenManagerConfig` still requires one), but signing out
    // with no client id configured is still meaningful — there may be a
    // stale token set left over from before the preference was cleared — so
    // fall back to a placeholder rather than no-op. `TokenManager.clear()`
    // never uses `clientId` itself, only `storageKey`.
    const manager = createTokenManager(ctx, clientId ?? 'unconfigured');
    await manager.clear();
  },

  async getIdentity(ctx: PluginContext): Promise<SourceIdentity | null> {
    return currentIdentity(ctx);
  },
};
