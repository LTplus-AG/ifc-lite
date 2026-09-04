/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Resolving what a user typed into the base URL of a BCF API service. */

import { BcfApiClient, normalizeBcfBaseUrl } from './client.js';
import { BcfApiError } from './errors.js';
import type { BcfAuthInfo, FetchLike } from './types.js';

/** Path vendors mount the BCF API at when the user is given a bare host. */
const CONVENTIONAL_BCF_PATH = '/bcf';

/**
 * Base URLs to try for a user-entered BCF server address, in order.
 *
 * Vendors serve the API under a path (`/bcf` on BIMcollab, `/api/bcf` on
 * OpenProject) but tell users to enter the bare space or instance address
 * — Solibri's and the BCF managers' BIMcollab setup is literally
 * "https://myspace.bimcollab.com". A host with no path of its own is
 * therefore ambiguous, so it yields a second candidate with `/bcf`
 * appended; anything that already names a path is taken at its word.
 */
export function bcfBaseUrlCandidates(input: string): string[] {
  const base = normalizeBcfBaseUrl(input);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // Not parseable: hand it back unchanged so the caller's request fails
    // with the address the user actually entered.
    return [base];
  }
  if (url.pathname !== '/' && url.pathname !== '') return [base];
  return [base, `${base}${CONVENTIONAL_BCF_PATH}`];
}

export interface DiscoverBcfServiceOptions {
  /** Server URL as the user entered it; normalized here. */
  baseUrl: string;
  /** BCF API version segment; defaults to '2.1'. */
  version?: string;
  fetchFn?: FetchLike;
}

export interface BcfServiceDiscovery {
  /** Resolved base URL, to construct every later client with. */
  baseUrl: string;
  /** The service's `/auth` document. */
  authInfo: BcfAuthInfo;
}

/**
 * Run `probe` against each candidate base URL until one succeeds, and hand
 * back what it returned. Any failure means "no BCF service here": a wrong
 * base answers with a 404, or with an SPA's HTML index that fails to parse.
 *
 * When every candidate fails, a rejected-credentials error wins — that is
 * the user's likelier mistake, and it proves the address was right —
 * otherwise the FIRST candidate's error is thrown, so the message names the
 * URL the user entered rather than a guess they never made.
 */
export async function resolveBcfBaseUrl<T>(
  input: string,
  probe: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const errors: unknown[] = [];
  for (const baseUrl of bcfBaseUrlCandidates(input)) {
    try {
      return await probe(baseUrl);
    } catch (error) {
      errors.push(error);
    }
  }
  throw errors.find((error) => error instanceof BcfApiError && error.isAuthError) ?? errors[0];
}

/**
 * Find the BCF service behind a user-entered address by fetching the `/auth`
 * discovery document from each candidate base URL.
 */
export function discoverBcfService(
  options: DiscoverBcfServiceOptions,
): Promise<BcfServiceDiscovery> {
  return resolveBcfBaseUrl(options.baseUrl, async (baseUrl) => {
    const client = new BcfApiClient({
      baseUrl,
      version: options.version,
      fetchFn: options.fetchFn,
    });
    return { baseUrl, authInfo: await client.getAuthInfo() };
  });
}
