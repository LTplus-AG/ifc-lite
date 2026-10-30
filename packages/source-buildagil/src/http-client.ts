/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from '@ifc-lite/plugin-api';
import { BUILDAGIL_API } from './manifest.js';

export class BuildagilHttpError extends Error {
  /** True when only a fresh sign-in can help. */
  readonly reauthenticationRequired: boolean;
  constructor(readonly status: number) {
    super(status === 401 ? 'buildagil session expired or not accepted; sign in again.'
      : status === 403 || status === 404 ? 'buildagil: not found, or your account has no access to it.'
      : status === 429 ? 'buildagil is throttling requests; try again in a moment.'
      : `buildagil request failed (${status}).`);
    this.name = 'BuildagilHttpError';
    this.reauthenticationRequired = status === 401;
  }
}

/**
 * Authenticated requests to the openCDE API. URLs name the real upstream:
 * `ctx.fetch` enforces the manifest's network allowlist and, in a browser
 * host, rewrites them onto the declared same-origin relay.
 */
export class BuildagilClient {
  constructor(private readonly getAccessToken: (ctx: PluginContext) => Promise<string>) {}

  async request(ctx: PluginContext, path: string, init: { method?: 'GET' | 'POST'; body?: unknown; accept?: string; signal?: AbortSignal } = {}): Promise<Response> {
    init.signal?.throwIfAborted();
    const token = await this.getAccessToken(ctx);
    init.signal?.throwIfAborted();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: init.accept ?? 'application/json' };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await ctx.fetch(`${BUILDAGIL_API}/${path}`, {
      method: init.method ?? 'GET', headers, signal: init.signal, credentials: 'omit',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (response.ok) return response;
    await response.body?.cancel();
    throw new BuildagilHttpError(response.status);
  }

  async json(ctx: PluginContext, path: string, init?: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }): Promise<unknown> {
    return (await this.request(ctx, path, init)).json();
  }
}
