/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Base-URL resolution shared by every OpenCDE API client. */

import { normalizeApiBaseUrl } from './client.js';
import { FoundationApiError } from './errors.js';
import { fetchJson, resolveFetch } from './http-client.js';
import type { FetchLike, FoundationVersion } from './types.js';

/**
 * Run `probe` against each candidate base URL until one succeeds, and hand
 * back what it returned. Any failure means "no service here": a wrong base
 * answers with a 404, or with an SPA's HTML index that fails to parse.
 *
 * A probe may therefore run against a base URL that turns out to be wrong,
 * so it must not commit anything (persist a session, register a client)
 * before the request that proves the address is right has succeeded.
 *
 * When every candidate fails, the error thrown is the most actionable one
 * available, in this order: a rejected-credentials error (the user's
 * likelier mistake, and it proves the address was right), then any error
 * naming a status and URL, then the first candidate's — so the message
 * describes what the user entered rather than a guess they never made. The
 * middle rung matters because a cross-origin probe that CORS blocks rejects
 * with a bare TypeError carrying neither status nor URL.
 */
export async function resolveApiBaseUrl<T>(
  candidates: string[],
  probe: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const errors: unknown[] = [];
  for (const baseUrl of candidates) {
    try {
      return await probe(baseUrl);
    } catch (error) {
      errors.push(error);
    }
  }
  const isApiError = (error: unknown): error is FoundationApiError =>
    error instanceof FoundationApiError;
  throw (
    errors.find((error) => isApiError(error) && error.isAuthError) ??
    errors.find(isApiError) ??
    errors[0]
  );
}

export interface FoundationVersionsOptions {
  /** Server base URL; the Foundation `/foundation/versions` endpoint always sits at this base, regardless of any api_base_url a specific API version reports. */
  baseUrl: string;
  fetchFn?: FetchLike;
}

/**
 * Fetch the Foundation API's `/foundation/versions` service (Foundation API
 * §2.1): every OpenCDE API and version the server hosts, and — via
 * `api_base_url` — where to reach each one. This is how a client discovers
 * that a server offers, say, `documents` 1.0 at all, and at what URL,
 * without hardcoding a path.
 */
export async function getFoundationVersions(
  options: FoundationVersionsOptions,
): Promise<FoundationVersion[]> {
  const fetchFn = resolveFetch(options.fetchFn);
  const url = `${normalizeApiBaseUrl(options.baseUrl)}/foundation/versions`;
  const result = await fetchJson<{ versions?: FoundationVersion[] }>(fetchFn, url);
  return result.versions ?? [];
}

/**
 * Pick the entry for `apiId` out of a `/foundation/versions` listing,
 * preferring the highest `version_id` when a server lists more than one.
 * Returns `undefined` when the server does not offer that API at all.
 */
export function findApiVersion(
  versions: FoundationVersion[],
  apiId: string,
): FoundationVersion | undefined {
  const matches = versions.filter((entry) => entry.api_id === apiId);
  if (matches.length === 0) return undefined;
  return matches.reduce((best, entry) =>
    entry.version_id.localeCompare(best.version_id, undefined, { numeric: true }) > 0
      ? entry
      : best,
  );
}

/**
 * Resolve the base URL to use for `apiId` from a `/foundation/versions`
 * entry: its own `api_base_url` when the server relocated the API, otherwise
 * `{serverBaseUrl}/{apiId}/{version_id}` (Foundation API §2.1: `api_base_url`
 * is optional — "to allow servers to relocate the API").
 *
 * Unlike `normalizeApiBaseUrl`, a server-provided `api_base_url` is trimmed
 * of only a trailing slash, never a version segment: `.../documents/1.0` IS
 * the API's own base URL here (the version already sits at its end), not a
 * user-typed address with a version pasted on by mistake.
 */
export function apiBaseUrlFor(serverBaseUrl: string, version: FoundationVersion): string {
  if (version.api_base_url) return version.api_base_url.trim().replace(/\/+$/, '');
  return `${normalizeApiBaseUrl(serverBaseUrl)}/${version.api_id}/${version.version_id}`;
}
