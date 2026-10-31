/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { OciError } from './errors.js';
import { isInsecureHost } from './reference.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * Calls `fetch` and turns a rejection into `NETWORK`. Caller aborts are
 * rethrown untouched so `AbortSignal` keeps its usual semantics. The message
 * names only the origin: request headers (and so credentials) never reach it.
 */
export async function guardedFetch(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (err) {
    if (isAbort(err)) throw err;
    const origin = new URL(url).origin;
    throw new OciError(
      'NETWORK',
      `Request to ${origin} failed before any response arrived (network error; in a browser, the registry may also have been blocked by CORS)`,
      { cause: err },
    );
  }
}

export interface FollowOptions {
  fetch: typeof fetch;
  /** Only this origin ever receives `authorization`. */
  registryOrigin: string;
  authorization?: string;
  headers: Record<string, string>;
  method?: 'GET';
  signal?: AbortSignal;
  insecureHosts: readonly string[] | undefined;
  what: string;
}

export interface FollowResult {
  response: Response;
  /** The URL that produced `response` (after redirects). */
  url: string;
}

/**
 * GET with `redirect: 'manual'`, following up to five redirects itself so it
 * controls what each hop receives: `Authorization` goes to the registry
 * origin only, never to a redirect target on another origin (a blob CDN), and
 * a hop to plain `http:` is refused unless its host is listed insecure.
 *
 * Node's fetch returns the real 3xx with its `Location`. A browser returns an
 * `opaqueredirect` whose target is hidden, which this reports as `PROTOCOL`
 * rather than mis-reading it as a status-0 failure.
 */
export async function fetchFollowing(startUrl: string, options: FollowOptions): Promise<FollowResult> {
  let url = startUrl;
  for (let hop = 0; ; hop++) {
    const current = new URL(url);
    const headers: Record<string, string> = { ...options.headers };
    if (options.authorization !== undefined && current.origin === options.registryOrigin) {
      headers.authorization = options.authorization;
    }
    const response = await guardedFetch(options.fetch, url, {
      method: options.method ?? 'GET',
      headers,
      redirect: 'manual',
      signal: options.signal,
    });
    if (response.type === 'opaqueredirect') {
      throw new OciError(
        'PROTOCOL',
        `${options.what}: the registry redirected, and this runtime hides manual redirect targets (browser fetch); the redirect cannot be followed safely here`,
      );
    }
    if (!REDIRECT_STATUSES.has(response.status)) return { response, url };
    await response.body?.cancel();
    if (hop >= MAX_REDIRECTS) {
      throw new OciError('PROTOCOL', `${options.what}: more than ${MAX_REDIRECTS} redirects`, { status: response.status });
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new OciError('PROTOCOL', `${options.what}: redirect ${response.status} without a Location header`, { status: response.status });
    }
    let next: URL;
    try {
      next = new URL(location, url);
    } catch (err) {
      throw new OciError('PROTOCOL', `${options.what}: unparseable redirect Location`, { status: response.status, cause: err });
    }
    if (next.username || next.password) {
      throw new OciError('PROTOCOL', `${options.what}: redirect target carries userinfo`, { status: response.status });
    }
    if (next.protocol === 'http:') {
      if (!isInsecureHost(next.host, options.insecureHosts)) {
        throw new OciError('PROTOCOL', `${options.what}: refusing redirect to plain http on ${next.host}`, { status: response.status });
      }
    } else if (next.protocol !== 'https:') {
      throw new OciError('PROTOCOL', `${options.what}: refusing redirect to ${next.protocol} URL`, { status: response.status });
    }
    url = next.href;
  }
}
