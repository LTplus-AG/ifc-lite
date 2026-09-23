/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FoundationApiError, extractErrorDetail } from './errors.js';
import type { FetchLike, FoundationTokenProvider } from './types.js';

/** Resolve an injectable fetch, falling back to the global one, bound. */
export function resolveFetch(fetchFn: FetchLike | undefined): FetchLike {
  if (fetchFn) return fetchFn;
  // Wrapped, not returned bare: browsers brand-check fetch's receiver, so a
  // detached reference can throw "Illegal invocation".
  if (typeof fetch === 'function') return (input, init) => fetch(input, init);
  throw new Error('No fetch implementation available; pass fetchFn explicitly.');
}

export interface FoundationHttpClientOptions {
  /** Supplies the Bearer token per request; omit for anonymous servers. */
  getAccessToken?: FoundationTokenProvider;
  /** Injectable fetch, for tests and non-browser hosts. */
  fetchFn?: FetchLike;
  /**
   * Name used in the fallback "{errorLabel} request failed (HTTP …) at …"
   * message when a non-2xx response carries no server-supplied detail.
   * Defaults to 'OpenCDE'; a concrete client (BCF, Documents, ...) names
   * itself so the message reads like the rest of that client's errors.
   */
  errorLabel?: string;
}

export interface HttpRequestOptions {
  method?: string;
  body?: unknown;
  /** Set when the body is already the wire representation (e.g. binary upload). */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  getAccessToken?: FoundationTokenProvider;
  errorLabel?: string;
}

/**
 * Send a request to an already-fully-qualified URL and validate the
 * response, mapping non-2xx responses to {@link FoundationApiError} with a
 * server-supplied detail when one is available. Free function (not a method)
 * so both the class-based clients below and one-off discovery calls (no
 * client instance yet) share the same request/error handling.
 */
export async function fetchAndValidate(
  fetchFn: FetchLike,
  url: string,
  options: HttpRequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  const token = await options.getAccessToken?.();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined = options.rawBody;
  if (body === undefined && options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetchFn(url, {
    method: options.method ?? 'GET',
    headers,
    body,
  });
  if (!response.ok) {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      // Non-JSON error body; the status line is all we can report.
      parsed = undefined;
    }
    const detail = extractErrorDetail(parsed);
    // Without a server-supplied detail the status alone says nothing about
    // WHICH request failed, and a wrong base URL is the common cause; name
    // the URL so the message is actionable.
    const label = options.errorLabel ?? 'OpenCDE';
    throw new FoundationApiError(
      detail ?? `${label} request failed (HTTP ${response.status}) at ${url}`,
      { status: response.status, url, detail },
    );
  }
  return response;
}

export async function fetchJson<T>(
  fetchFn: FetchLike,
  url: string,
  options: HttpRequestOptions = {},
): Promise<T> {
  const response = await fetchAndValidate(fetchFn, url, options);
  return (await response.json()) as T;
}

/**
 * Shared plumbing every OpenCDE REST client needs: Bearer token injection,
 * JSON body encoding, and error mapping via {@link fetchAndValidate}.
 * `BcfApiClient` and `DocumentsApiClient` both build on this rather than
 * reimplementing it.
 */
export abstract class FoundationHttpClient {
  protected readonly getAccessToken?: FoundationTokenProvider;
  protected readonly fetchFn: FetchLike;
  protected readonly errorLabel: string;

  constructor(options: FoundationHttpClientOptions = {}) {
    this.getAccessToken = options.getAccessToken;
    this.fetchFn = resolveFetch(options.fetchFn);
    this.errorLabel = options.errorLabel ?? 'OpenCDE';
  }

  /** Send a request to an already-fully-qualified URL and validate the response. */
  protected sendRequest(url: string, options: HttpRequestOptions = {}): Promise<Response> {
    return fetchAndValidate(this.fetchFn, url, {
      errorLabel: this.errorLabel,
      ...options,
      getAccessToken: this.getAccessToken,
    });
  }

  protected async requestJson<T>(url: string, options: HttpRequestOptions = {}): Promise<T> {
    const response = await this.sendRequest(url, options);
    return (await response.json()) as T;
  }
}
