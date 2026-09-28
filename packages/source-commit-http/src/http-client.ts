/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CommitPayloadFormat, PluginContext } from '@ifc-lite/plugin-api';

import { CommitHttpError, errorFromResponse } from './errors.js';

/** Media type per payload format, both directions. */
export const MEDIA_TYPES: Readonly<Record<CommitPayloadFormat, string>> = {
  'ifc-step': 'application/x-step',
  'ifc-zip': 'application/zip',
  ifcx: 'application/json',
  'ifc-lite-cache': 'application/vnd.ifc-lite.cache',
};

export function formatForMediaType(mediaType: string | null): CommitPayloadFormat | undefined {
  if (!mediaType) return undefined;
  const bare = mediaType.split(';')[0].trim().toLowerCase();
  for (const [format, type] of Object.entries(MEDIA_TYPES)) {
    if (type === bare) return format as CommitPayloadFormat;
  }
  return undefined;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/**
 * One request helper for the whole REST contract.
 *
 * The base URL is joined by hand rather than with `new URL(path, base)`:
 * a service deployed under a path prefix (`https://host/api/v1`) loses that
 * prefix to `new URL`'s absolute-path resolution, which is the classic way a
 * generic client works in staging and 404s in production.
 */
export class CommitHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly ctx: PluginContext,
    private readonly getAccessToken: () => Promise<string>,
  ) {}

  url(path: string, query?: RequestOptions['query']): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async raw(path: string, options: RequestOptions = {}): Promise<Response> {
    const token = await this.getAccessToken();
    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body !== undefined && !(options.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...options.headers,
      },
      ...(options.body !== undefined
        ? { body: options.body instanceof FormData ? options.body : JSON.stringify(options.body) }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };

    const url = this.url(path, options.query);
    this.ctx.log.debug('commit-http request', { url, method: init.method });
    const response = await this.ctx.fetch(url, init);
    if (response.ok && response.status !== 202) return response;

    // 202 is `not-ready` in this contract, not success: a service computing a
    // diff answers it with a `retryAfterMs`, and treating it as a body would
    // parse the "still working" envelope as the diff itself.
    const rawBody = await response.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      parsed = undefined;
    }
    const error = errorFromResponse(response.status, parsed, rawBody);
    // A 202 with no advertised delay still has to carry one, or a host's
    // retry loop is left guessing.
    if (error.code === 'not-ready' && error.retryAfterMs === undefined) {
      const header = response.headers.get('Retry-After');
      const seconds = header ? Number(header) : Number.NaN;
      throw new CommitHttpError(error.code, error.message, response.status, {
        retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : 1000,
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
    }
    throw error;
  }

  async json<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.raw(path, options);
    return (await response.json()) as T;
  }
}
