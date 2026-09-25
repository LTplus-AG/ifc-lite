/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FoundationHttpClient, type FoundationHttpClientOptions } from './http-client.js';
import type { ApiVersion, FoundationAuthInfo, FoundationCurrentUser } from './types.js';

/**
 * Strip whitespace, any query or fragment, trailing slashes, and an
 * accidentally pasted version segment ('/2.1', '/1.0') from a user-entered
 * OpenCDE server URL, so `https://host/bcf/2.1/` and `https://host/bcf`
 * configure the same client.
 *
 * A base URL is a path prefix that request paths are appended to, so a query
 * or fragment is never part of it — and one pasted out of a browser address
 * bar (`https://myspace.bimcollab.com/#/projects`) would otherwise be
 * carried into every request URL.
 */
export function normalizeApiBaseUrl(input: string): string {
  let url = input.trim();
  try {
    const parsed = new URL(url);
    if (parsed.search !== '' || parsed.hash !== '') {
      parsed.search = '';
      parsed.hash = '';
      url = parsed.toString();
    }
  } catch {
    // Not an absolute URL; the string rules below still apply.
  }
  while (url.endsWith('/')) url = url.slice(0, -1);
  const versionSuffix = /\/(\d+\.\d+)$/.exec(url);
  if (versionSuffix) url = url.slice(0, -versionSuffix[0].length);
  return url;
}

export interface FoundationApiClientOptions extends FoundationHttpClientOptions {
  /**
   * Server base URL up to but excluding the version segment, e.g.
   * `https://example.com/bcf`. Run user input through
   * {@link normalizeApiBaseUrl} first to tolerate trailing slashes and
   * pasted version suffixes.
   */
  baseUrl: string;
  /** OpenCDE API version segment; defaults to '1.1' (the Foundation API's own version). */
  version?: string;
}

export interface FoundationRequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/**
 * Base client for every OpenCDE REST API mounted under `{baseUrl}/{version}`
 * with a sibling `/versions` resource (Foundation API §2.1). Implements the
 * three services the Foundation API itself defines — versions, `/auth`
 * discovery and `/current-user` — plus the URL building and JSON request
 * plumbing that `BcfApiClient` (and any future OpenCDE service client built
 * the same way) extends with its own resources.
 */
export class FoundationApiClient extends FoundationHttpClient {
  protected readonly baseUrl: string;
  protected readonly version: string;

  constructor(options: FoundationApiClientOptions) {
    super(options);
    this.baseUrl = normalizeApiBaseUrl(options.baseUrl);
    this.version = options.version ?? '1.1';
  }

  protected buildUrl(path: string, query?: FoundationRequestOptions['query']): string {
    // `/versions` sits beside the version segment, not under it (Foundation API §2.1).
    const prefix = path === '/versions' ? this.baseUrl : `${this.baseUrl}/${this.version}`;
    const url = new URL(`${prefix}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  protected send(path: string, options: FoundationRequestOptions): Promise<Response> {
    return this.sendRequest(this.buildUrl(path, options.query), {
      method: options.method,
      body: options.body,
    });
  }

  protected requestJsonAt<T>(path: string, options: FoundationRequestOptions = {}): Promise<T> {
    return this.requestJson<T>(this.buildUrl(path, options.query), {
      method: options.method,
      body: options.body,
    });
  }

  // -- Discovery & identity (Foundation API §2, §3) --------------------------

  /** This API's own `{base}/versions` listing; see `getFoundationVersions` for the server-wide one. */
  async getVersions(): Promise<ApiVersion[]> {
    const result = await this.requestJsonAt<{ versions?: ApiVersion[] }>('/versions');
    return result.versions ?? [];
  }

  getAuthInfo(): Promise<FoundationAuthInfo> {
    return this.requestJsonAt<FoundationAuthInfo>('/auth');
  }

  getCurrentUser(): Promise<FoundationCurrentUser> {
    return this.requestJsonAt<FoundationCurrentUser>('/current-user');
  }
}
