/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DownloadOptions, PluginContext, SourceFileRef, SourceIdentity } from '@ifc-lite/plugin-api';

export const APS_ORIGIN = 'https://developer.api.autodesk.com';
export type Region = 'US' | 'EMEA';

/** Host-owned, cookie-authenticated transport. Never put this on PluginContext.fetch. */
export interface AutodeskService {
  identity(signal?: AbortSignal): Promise<SourceIdentity | null>;
  startSignIn(signal?: AbortSignal): Promise<{ url: string; state: string }>;
  signOut(): Promise<void>;
  cancelSignIn?(): Promise<void>;
  request(path: string, region: Region, signal?: AbortSignal): Promise<unknown>;
  downloadStorage(storageId: string, region: Region, options?: DownloadOptions): Promise<ArrayBuffer>;
  /** Deployment declares only installed, qualified native artifact adapters. */
  readonly imports: readonly ('exchange' | 'proposal')[];
  importResource(ref: SourceFileRef, region: Region, options?: DownloadOptions): Promise<ArrayBuffer>;
}

export class AutodeskError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = 'AutodeskError';
  }
}

export function record(value: unknown, label = 'Autodesk response'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AutodeskError('invalid-response', `${label} is not an object.`);
  }
  return value as Record<string, unknown>;
}
export function text(value: unknown, label = 'identifier'): string {
  if (typeof value !== 'string' || !value || value.length > 16_384) {
    throw new AutodeskError('invalid-response', `Autodesk returned an invalid ${label}.`);
  }
  return value;
}
export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
export function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new AutodeskError('invalid-response', 'Autodesk returned an invalid or oversized page.');
  }
  return value.map((row) => record(row));
}
export function attributes(value: Record<string, unknown>): Record<string, unknown> {
  return value.attributes === undefined ? {} : record(value.attributes);
}
export function relation(value: Record<string, unknown>, key: string): string | undefined {
  if (!value.relationships) return undefined;
  const rel = record(value.relationships)[key];
  if (!rel) return undefined;
  const data = record(rel).data;
  if (!data || Array.isArray(data)) return undefined;
  return optionalText(record(data).id);
}
export function nextLink(value: Record<string, unknown>, expectedPath: string): string | undefined {
  if (!value.links) return undefined;
  const next = record(value.links).next;
  if (!next) return undefined;
  const raw = typeof next === 'string' ? next : optionalText(record(next).href);
  if (!raw) return undefined;
  return checkedPath(raw, expectedPath);
}
/** A continuation may change query parameters, never the origin or endpoint. */
export function checkedPath(raw: string, expectedPath?: string): string {
  const url = new URL(raw, APS_ORIGIN);
  if (url.origin !== APS_ORIGIN || url.username || url.password || url.hash ||
      (expectedPath !== undefined && url.pathname !== expectedPath)) {
    throw new AutodeskError('invalid-link', 'Autodesk returned an unexpected continuation URL.');
  }
  if (!/^\/(project|data|oss|forma|exchange|userprofile|authentication)\//.test(url.pathname)) {
    throw new AutodeskError('invalid-link', 'Unsupported Autodesk API path.');
  }
  return `${url.pathname}${url.search}`;
}
export function enc(value: string): string { return encodeURIComponent(value); }

export function storageParts(storageId: string): { bucket: string; object: string } {
  const match = /^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/.exec(storageId);
  if (!match) throw new AutodeskError('invalid-storage', 'The selected version has no supported storage reference.');
  return { bucket: match[1], object: match[2] };
}
export function checkResponse(response: Response): void {
  if (response.ok) return;
  const messages: Record<number, string> = {
    401: 'Your Autodesk session expired. Sign in again.',
    403: 'Autodesk denied access. Check your project permissions and the account’s Custom Integrations setup.',
    404: 'This Autodesk resource or revision is no longer available.',
    429: 'Autodesk is limiting requests. Try again shortly.',
  };
  throw new AutodeskError(`http-${response.status}`, messages[response.status] ?? 'The Autodesk request failed. Try again.', response.status);
}

export interface Api {
  get(path: string, region?: Region, signal?: AbortSignal): Promise<unknown>;
  storage(storageId: string, region: Region, options?: DownloadOptions): Promise<ArrayBuffer>;
}
export function createApi(ctx: PluginContext, token: () => Promise<string>, service?: AutodeskService): Api {
  const get = async (path: string, region: Region = 'US', signal?: AbortSignal): Promise<unknown> => {
    const safe = checkedPath(path);
    if (service) return service.request(safe, region, signal);
    const response = await ctx.fetch(`${APS_ORIGIN}${safe}`, {
      headers: { Authorization: `Bearer ${await token()}`, 'X-Ads-Region': region }, signal,
    });
    checkResponse(response);
    return response.json() as Promise<unknown>;
  };
  return {
    get,
    async storage(id, region, options) {
      if (service) return service.downloadStorage(id, region, options);
      const { bucket, object } = storageParts(id);
      const signed = record(await get(`/oss/v2/buckets/${enc(bucket)}/objects/${enc(object)}/signeds3download`, region, options?.signal));
      const response = await ctx.fetchPublic(text(signed.url, 'signed download URL'), { signal: options?.signal });
      checkResponse(response);
      const { readWithProgress } = await import('@ifc-lite/plugin-api');
      return readWithProgress(response, options?.onProgress);
    },
  };
}
