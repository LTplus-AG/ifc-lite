/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from '@ifc-lite/plugin-api';
import type { BimcollabSession } from './types.js';

export class BimcollabHttpError extends Error {
  readonly reauthenticationRequired: boolean;
  constructor(readonly status: number, readonly downloadUnavailable = false) {
    super(status === 401 ? 'BIMcollab session expired or not accepted; sign in again.'
      : status === 403 ? 'BIMcollab: no document access in this space.'
      : downloadUnavailable ? 'BIMcollab: no download URL available for this document.'
      : `BIMcollab request failed (${status}).`);
    this.name = 'BimcollabHttpError';
    this.reauthenticationRequired = status === 401;
  }
}

export interface BimcollabTransport {
  docs(ctx: PluginContext, session: BimcollabSession, path: string, signal?: AbortSignal): Promise<Response>;
  index(ctx: PluginContext, session: BimcollabSession, locationId: number, signal?: AbortSignal): Promise<Response>;
  download(ctx: PluginContext, session: BimcollabSession, versionId: number, signal?: AbortSignal): Promise<Response>;
}

export async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  const unavailable = response.status === 404 && /No download URL available for this document/i.test(await response.text());
  throw new BimcollabHttpError(response.status, unavailable);
}

export class RelayBimcollabTransport implements BimcollabTransport {
  private readonly base: string;
  /** fetchFn must be a host-approved same-origin fetch, not the upstream-rewriting ctx.fetch. */
  constructor(baseUrl = '/api/bimcollab', private readonly fetchFn?: typeof fetch) {
    if (!baseUrl.startsWith('/') || baseUrl.startsWith('//') || /[?#\\]/.test(baseUrl)) {
      throw new Error('BIMcollab relay must be a same-origin absolute path.');
    }
    this.base = baseUrl.replace(/\/+$/, '');
  }
  private async request(ctx: PluginContext, session: BimcollabSession, path: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const token = await session.getAccessToken();
    signal?.throwIfAborted();
    return checked(await (this.fetchFn ?? ctx.fetch)(`${this.base}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal, credentials: 'omit', redirect: 'error',
    }));
  }
  docs(ctx: PluginContext, s: BimcollabSession, path: string, signal?: AbortSignal) {
    return this.request(ctx, s, `docs/${encodeURIComponent(s.spaceGuid)}/${path}`, signal);
  }
  index(ctx: PluginContext, s: BimcollabSession, locationId: number, signal?: AbortSignal) {
    return this.request(ctx, s, `space/${encodeURIComponent(s.spaceLabel)}/index?locationId=${locationId}`, signal);
  }
  download(ctx: PluginContext, s: BimcollabSession, versionId: number, signal?: AbortSignal) {
    return this.request(ctx, s, `space/${encodeURIComponent(s.spaceLabel)}/download/${versionId}`, signal);
  }
}

/** Node/CLI public API transport. Legacy web-app downloads require a relay. */
export class DirectBimcollabTransport implements BimcollabTransport {
  constructor(private readonly fetchFn: typeof fetch, private readonly origin = 'https://api.eu.bimcollab.com') {
    if (new URL(origin).protocol !== 'https:') throw new Error('BIMcollab API requires HTTPS.');
  }
  async docs(_ctx: PluginContext, s: BimcollabSession, path: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const token = await s.getAccessToken();
    return checked(await this.fetchFn(`${this.origin}/spaces/${encodeURIComponent(s.spaceGuid)}/documents/v1/${path}`, {
      headers: { Authorization: `Bearer ${token}` }, signal, credentials: 'omit', redirect: 'error',
    }));
  }
  async index(): Promise<Response> { throw new Error('Legacy BIMcollab download requires a relay transport.'); }
  async download(): Promise<Response> { throw new Error('Legacy BIMcollab download requires a relay transport.'); }
}
