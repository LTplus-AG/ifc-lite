/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readWithProgress, type DownloadOptions, type SourceIdentity } from '@ifc-lite/plugin-api';

export type HostedVendor = 'dropbox' | 'msgraph';
export interface HostedSession { identity: SourceIdentity | null; csrf: string; configured: boolean }
export class HostedCloudError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code === 'unconfigured'
      ? 'This cloud source is not configured. Ask the viewer administrator to enable vendor sign-in.'
      : status === 401 ? 'Your cloud session expired. Sign in again.'
      : status === 409 ? 'This file changed. Refresh the file list and try again.'
      : status === 503 ? 'This cloud source is busy or unavailable. Try again shortly.'
      : 'The cloud request could not be completed. Try again.');
    this.name = 'HostedCloudError';
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cloud response.');
  return value as Record<string, unknown>;
}
/** Same-origin only: no provider-scoped fetch, vendor tokens or signed URLs. */
export class HostedCloudClient {
  constructor(readonly vendor: HostedVendor, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  private async check(response: Response): Promise<Response> {
    if (response.ok) return response;
    let code = 'request-failed';
    try { const data = object(await response.json()); if (typeof data.error === 'string' && /^[a-z-]{1,60}$/.test(data.error)) code = data.error; }
    catch (error) { console.warn('[sources] Cloud gateway returned an invalid error response', error instanceof Error ? error.name : 'unknown'); }
    throw new HostedCloudError(response.status, code);
  }
  async session(signal?: AbortSignal): Promise<HostedSession> {
    const response = await this.check(await this.fetcher(`/api/cloud/${this.vendor}/session`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal }));
    const value = object(await response.json());
    if (typeof value.csrf !== 'string' || !value.csrf || typeof value.configured !== 'boolean') throw new Error('Invalid cloud session response.');
    let identity: SourceIdentity | null = null;
    if (value.identity !== null) {
      const raw = object(value.identity);
      if (typeof raw.id !== 'string' || !raw.id) throw new Error('Invalid cloud identity response.');
      identity = { id: raw.id, displayName: typeof raw.displayName === 'string' ? raw.displayName : undefined,
        email: typeof raw.email === 'string' ? raw.email : undefined, organization: typeof raw.organization === 'string' ? raw.organization : undefined };
    }
    return { csrf: value.csrf, configured: value.configured, identity };
  }
  async post(action: string, body: unknown = {}, signal?: AbortSignal): Promise<Response> {
    const session = await this.session(signal);
    signal?.throwIfAborted();
    return this.check(await this.fetcher(`/api/cloud/${this.vendor}/${action}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', 'x-ifclite-csrf': session.csrf }, body: JSON.stringify(body),
    }));
  }
  async request(body: unknown, signal?: AbortSignal): Promise<unknown> { return (await this.post('request', body, signal)).json(); }
  async download(body: unknown, options?: DownloadOptions): Promise<ArrayBuffer> {
    const response = await this.post('download', body, options?.signal);
    return readWithProgress(response, options?.onProgress);
  }
}
