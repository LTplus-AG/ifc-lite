/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Host side of the BIMcollab Documents source. The package provider is
 * session-agnostic; this wrapper binds it to the viewer's saved BIMcollab
 * BCF connection (same OAuth app, same tokens, same refresh single-flight),
 * so a user who connected BCF to their space can open its models with no
 * second sign-in.
 *
 * Requests go to the same-origin relay (`api/bimcollab.ts`): BIMcollab's
 * Documents host sends no Access-Control-Allow-Headers, so a browser cannot
 * attach `Authorization` to it directly. The injected fetch is locked to the
 * relay path, so this provider cannot reach anything else through it.
 */

import type {
  DownloadOptions, FileFilter, FileSourceProvider, ListOptions, ListProjectsOptions,
  PluginContext, PluginManifest, SourceAuth, SourceFileRef, SourceIdentity,
} from '@ifc-lite/plugin-api';
import {
  BIMCOLLAB_MANIFEST, BimcollabProvider, RelayBimcollabTransport,
  isBimcollabServerUrl, spaceIdFromAccessToken, spaceLabelFromServerUrl,
} from '@ifc-lite/source-bimcollab';
import { connectedTokenSource, loadBcfServerConfig } from '../bcf-server.js';
import type { BcfServerConfig } from '../bcf-server-config.js';

export const BIMCOLLAB_RELAY_PATH = '/api/bimcollab';
const SIGNED_OUT_KEY = 'signedOutSession';

/** Same-origin fetch that only ever reaches the BIMcollab relay. */
export function relayOnlyFetch(origin: string, relayPath = BIMCOLLAB_RELAY_PATH): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    if (url.origin !== origin || !url.pathname.startsWith(`${relayPath}/`)) {
      return Promise.reject(new Error(`BIMcollab source may only call ${relayPath}/`));
    }
    return fetch(url, { ...init, credentials: 'omit' });
  };
}

/**
 * One refresh-and-retry on 401, as the BCF client does: a token without a
 * recorded expiry is only discovered stale by the server, and its refresh
 * token may still be valid.
 */
export function retryUnauthorized(fetchFn: typeof fetch, refresh: () => Promise<string | null>): typeof fetch {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    if (response.status !== 401) return response;
    const freshToken = await refresh();
    if (freshToken === null) return response;
    await response.body?.cancel();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${freshToken}`);
    return fetchFn(input, { ...init, headers });
  };
}

export class BimcollabNotConnectedError extends Error {
  constructor() {
    super('Connect your BIMcollab space first: open BCF Topics, choose BCF server, pick BIMcollab and sign in. Then return here.');
    this.name = 'BimcollabNotConnectedError';
  }
}

interface BoundSession { key: string; provider: BimcollabProvider; config: BcfServerConfig }

/**
 * The saved BCF connection, if it is a BIMcollab space whose token carries a
 * space id. Anything else (another BCF server, an opaque token) is "not connected".
 */
export function bimcollabSessionFromConfig(config: BcfServerConfig | null): { config: BcfServerConfig; spaceGuid: string; spaceLabel: string } | null {
  if (!config || !isBimcollabServerUrl(config.serverUrl)) return null;
  const spaceLabel = spaceLabelFromServerUrl(config.serverUrl);
  const spaceGuid = spaceIdFromAccessToken(config.accessToken);
  return spaceLabel && spaceGuid ? { config, spaceGuid, spaceLabel } : null;
}

export class ViewerBimcollabProvider implements FileSourceProvider {
  readonly manifest: PluginManifest = { ...BIMCOLLAB_MANIFEST, auth: 'interactive' };
  readonly auth: SourceAuth;
  private bound: BoundSession | null = null;

  constructor(
    private readonly loadConfig: () => BcfServerConfig | null = loadBcfServerConfig,
    private readonly fetchFn: typeof fetch = relayOnlyFetch(window.location.origin),
  ) {
    this.auth = {
      restore: async (ctx) => (await this.signedOut(ctx) ? null : this.identity()),
      getIdentity: async (ctx) => (await this.signedOut(ctx) ? null : this.identity()),
      signIn: async (ctx) => {
        const identity = this.identity();
        if (!identity) throw new BimcollabNotConnectedError();
        await ctx.storage.delete(SIGNED_OUT_KEY);
        return identity;
      },
      // The tokens belong to the BCF connection, which stays connected; this
      // source just stops using them for that account until signed in again.
      signOut: async (ctx) => {
        this.bound = null;
        const key = this.sessionKey();
        if (key) await ctx.storage.set(SIGNED_OUT_KEY, key);
      },
    };
  }

  private sessionKey(): string | null {
    const session = bimcollabSessionFromConfig(this.loadConfig());
    return session ? [session.config.serverUrl, session.config.userId, session.spaceGuid].join('\u0000') : null;
  }

  /** Signed out applies to the account it was given for; a different account is not signed out. */
  private async signedOut(ctx: PluginContext): Promise<boolean> {
    const marker = await ctx.storage.get(SIGNED_OUT_KEY);
    return marker !== undefined && marker === this.sessionKey();
  }

  private async active(ctx: PluginContext): Promise<BimcollabProvider> {
    if (await this.signedOut(ctx)) throw new BimcollabNotConnectedError();
    return this.provider();
  }

  private identity(): SourceIdentity | null {
    const session = bimcollabSessionFromConfig(this.loadConfig());
    if (!session) return null;
    return { id: session.config.userId || session.spaceGuid, displayName: session.config.userId || undefined,
      email: session.config.userId.includes('@') ? session.config.userId : undefined, organization: session.spaceLabel };
  }

  /** The package provider for the CURRENT connection; rebuilt when the account or space changes. */
  private provider(): BimcollabProvider {
    const session = bimcollabSessionFromConfig(this.loadConfig());
    if (!session) throw new BimcollabNotConnectedError();
    const key = this.sessionKey() ?? '';
    if (this.bound?.key !== key) {
      const tokens = connectedTokenSource(session.config);
      this.bound = {
        key, config: session.config,
        provider: new BimcollabProvider({
          session: { spaceGuid: session.spaceGuid, spaceLabel: session.spaceLabel, getAccessToken: tokens.getAccessToken },
          transport: new RelayBimcollabTransport(BIMCOLLAB_RELAY_PATH, retryUnauthorized(this.fetchFn, tokens.refreshAfterUnauthorized)),
        }),
      };
    }
    return this.bound.provider;
  }

  // async: a missing session must reject, never throw synchronously into the host.
  async listProjects(ctx: PluginContext, options?: ListProjectsOptions) { return (await this.active(ctx)).listProjects(ctx, options); }
  async listContainers(ctx: PluginContext, projectId: string, parentId?: string, options?: ListOptions) {
    return (await this.active(ctx)).listContainers(ctx, projectId, parentId, options);
  }
  async listFiles(ctx: PluginContext, projectId: string, containerId: string, filter?: FileFilter, options?: ListOptions) {
    return (await this.active(ctx)).listFiles(ctx, projectId, containerId, filter, options);
  }
  async searchFiles(ctx: PluginContext, projectId: string, query: string, filter?: FileFilter, options?: ListOptions) {
    return (await this.active(ctx)).searchFiles(ctx, projectId, query, filter, options);
  }
  async listRevisions(ctx: PluginContext, ref: SourceFileRef, options?: ListOptions) { return (await this.active(ctx)).listRevisions(ctx, ref, options); }
  async download(ctx: PluginContext, ref: SourceFileRef, options?: DownloadOptions) { return (await this.active(ctx)).download(ctx, ref, options); }
}
