/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext, SourceAuth, SourceIdentity } from '@ifc-lite/plugin-api';

/**
 * None of these require admin consent as delegated permissions (tenant
 * policy may still force it) — see the package README's Entra registration
 * steps.
 */
const SCOPES: readonly string[] = [
  'User.Read',
  'Files.Read.All',
  'Sites.Read.All',
  'openid',
  'profile',
  'offline_access',
];

export const DEFAULT_AUTHORITY = 'https://login.microsoftonline.com/common';

// ---------------------------------------------------------------------------
// Minimal structural types for the slice of `@azure/msal-browser` this file
// drives. Kept local instead of importing the library's own types at every
// call site so the dynamic `import()` below is the *only* place this module
// touches the real package — which is what lets tests `vi.mock` it away
// entirely without ever constructing a real `PublicClientApplication` or
// hitting `login.microsoftonline.com`.
// ---------------------------------------------------------------------------

interface MsalAccount {
  readonly homeAccountId: string;
  readonly username?: string;
  readonly name?: string;
  readonly tenantId?: string;
}

interface MsalAuthResult {
  readonly account: MsalAccount | null;
  readonly accessToken: string;
}

export interface MsalPublicClientApplication {
  initialize(): Promise<void>;
  getAllAccounts(): MsalAccount[];
  getActiveAccount(): MsalAccount | null;
  setActiveAccount(account: MsalAccount | null): void;
  loginPopup(request: { scopes: readonly string[] }): Promise<MsalAuthResult>;
  acquireTokenSilent(request: { scopes: readonly string[]; account: MsalAccount }): Promise<MsalAuthResult>;
  acquireTokenPopup(request: { scopes: readonly string[]; account: MsalAccount }): Promise<MsalAuthResult>;
  logoutPopup(request?: { account?: MsalAccount | null }): Promise<void>;
}

interface MsalBrowserModule {
  PublicClientApplication: new (config: unknown) => MsalPublicClientApplication;
  InteractionRequiredAuthError: new (...args: unknown[]) => Error;
}

let msalModulePromise: Promise<MsalBrowserModule> | undefined;

/**
 * Loaded lazily so importing `@ifc-lite/source-msgraph` never pulls MSAL's
 * ~130KB into a bundle (or a test run) until something actually
 * authenticates.
 */
function loadMsalModule(): Promise<MsalBrowserModule> {
  msalModulePromise ??= import('@azure/msal-browser') as Promise<MsalBrowserModule>;
  return msalModulePromise;
}

/** Thrown when the refresh token has expired and a second interactive attempt still failed. */
export class GraphAuthExpiredError extends Error {
  constructor(message = 'Microsoft sign-in expired. Please sign in again.') {
    super(message);
    this.name = 'GraphAuthExpiredError';
  }
}

function isInteractionRequiredError(
  err: unknown,
  InteractionRequiredAuthError: MsalBrowserModule['InteractionRequiredAuthError'],
): boolean {
  if (err instanceof InteractionRequiredAuthError) return true;
  // Belt-and-braces: errors that cross a `vi.mock`'d module boundary in
  // tests won't satisfy `instanceof` against the real class.
  return err instanceof Error && err.name === 'InteractionRequiredAuthError';
}

function toIdentity(account: MsalAccount): SourceIdentity {
  return {
    id: account.homeAccountId,
    displayName: account.name,
    email: account.username,
    organization: account.tenantId,
  };
}

/**
 * Wraps an MSAL `PublicClientApplication` for one signed-in Microsoft
 * account. Implements `SourceAuth` for the host's sign-in/sign-out UI, and
 * additionally exposes `getAccessToken`, which the provider calls before
 * every Graph request — that method isn't part of the `SourceAuth` contract
 * (it returns a bearer token, not an identity), but `MsGraphProvider` owns
 * this class directly so it can reach it.
 */
export class MsGraphAuth implements SourceAuth {
  private client: MsalPublicClientApplication | undefined;
  private clientKey: string | undefined;

  private async getClient(ctx: PluginContext): Promise<MsalPublicClientApplication> {
    const clientId = await ctx.getPreference('clientId');
    if (!clientId) {
      throw new Error(
        'Microsoft Graph client ID not configured. Add an Entra app registration client ID in Source Settings.',
      );
    }
    const authority = (await ctx.getPreference('authority')) || DEFAULT_AUTHORITY;
    const key = `${clientId}::${authority}`;

    if (this.client && this.clientKey === key) return this.client;

    const { PublicClientApplication } = await loadMsalModule();
    // The redirect bridge page — see apps/viewer/msal-redirect.html — is
    // required because this app runs with Cross-Origin-Opener-Policy:
    // same-origin for SharedArrayBuffer isolation, which severs the
    // window.opener link classic MSAL popup flows depend on. MSAL v5 routes
    // every flow (including loginPopup) through this bridge instead.
    const redirectUri = `${window.location.origin}/msal-redirect.html`;
    const client = new PublicClientApplication({
      auth: { clientId, authority, redirectUri },
      cache: { cacheLocation: 'localStorage' },
    });
    await client.initialize();

    this.client = client;
    this.clientKey = key;
    return client;
  }

  /** Silent, non-blocking: reads whatever account MSAL already has cached. Never opens a popup. */
  async restore(ctx: PluginContext): Promise<SourceIdentity | null> {
    const client = await this.getClient(ctx);
    const active = client.getActiveAccount();
    if (active) return toIdentity(active);

    const [first] = client.getAllAccounts();
    if (!first) return null;
    client.setActiveAccount(first);
    return toIdentity(first);
  }

  /** Interactive. Callers must only invoke this from a user gesture. */
  async signIn(ctx: PluginContext): Promise<SourceIdentity> {
    const client = await this.getClient(ctx);
    const result = await client.loginPopup({ scopes: SCOPES });
    const account = result.account ?? client.getAllAccounts()[0];
    if (!account) throw new Error('Microsoft sign-in completed without returning an account.');
    client.setActiveAccount(account);
    return toIdentity(account);
  }

  async signOut(ctx: PluginContext): Promise<void> {
    const client = await this.getClient(ctx);
    const active = client.getActiveAccount() ?? client.getAllAccounts()[0] ?? null;
    // A popup, not `logoutRedirect` — a full-page navigation here would
    // destroy whatever model the viewer already has loaded.
    await client.logoutPopup({ account: active });
    client.setActiveAccount(null);
  }

  async getIdentity(ctx: PluginContext): Promise<SourceIdentity | null> {
    const client = await this.getClient(ctx);
    const active = client.getActiveAccount() ?? client.getAllAccounts()[0];
    return active ? toIdentity(active) : null;
  }

  /**
   * Not part of `SourceAuth` — called by the provider before every Graph
   * request. Access tokens last ~1h, so most calls resolve silently;
   * refresh tokens for SPA redirect URIs expire after ~24h, at which point
   * `acquireTokenSilent` throws `InteractionRequiredAuthError` and this
   * falls back to a popup. If that popup also fails (most likely because
   * this call isn't running from a user gesture), the caller gets a
   * `GraphAuthExpiredError` it can present as "sign in again" rather than
   * the raw MSAL failure.
   */
  async getAccessToken(ctx: PluginContext): Promise<string> {
    const client = await this.getClient(ctx);
    const account = client.getActiveAccount() ?? client.getAllAccounts()[0];
    if (!account) {
      throw new Error('Not signed in to Microsoft Graph. Call signIn() from a user gesture first.');
    }

    const { InteractionRequiredAuthError } = await loadMsalModule();
    try {
      const result = await client.acquireTokenSilent({ scopes: SCOPES, account });
      return result.accessToken;
    } catch (err) {
      if (!isInteractionRequiredError(err, InteractionRequiredAuthError)) throw err;

      try {
        const result = await client.acquireTokenPopup({ scopes: SCOPES, account });
        return result.accessToken;
      } catch {
        throw new GraphAuthExpiredError();
      }
    }
  }
}
