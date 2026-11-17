/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF servers that need more than the BCF API 2.1 discovery the connector
 * assumes. A profile is keyed by the exact server URL, so a saved connection
 * keeps its behaviour without anything new persisted.
 *
 * buildagil's openCDE API serves BCF-shaped topics under `/1.0/…`, but
 * (measured against the live API, 2026-11-02):
 *   - it has no `/{version}/auth` and no `current-user`, so the sign-in
 *     endpoints are fixed here and the account comes from the token;
 *   - it sends no CORS headers to most origins, so every request, token
 *     grants included, goes through the same-origin `/api/buildagil` relay
 *     (`server/sources/buildagil-relay.ts`);
 *   - its topic list ignores `$skip`, so topics are paged by `modified_date`;
 *   - only some topic types keep a status (a status sent with `Information`
 *     returns 201 and is stored as null).
 */

import type { BcfAuthInfo, FetchLike } from '@ifc-lite/bcf-api';
import { applyRelay } from './sources/host-fetch.js';

export interface BcfServerProfile {
  /** BCF API version segment the server serves its routes under. */
  readonly version: string;
  /** Authorization and token endpoints, in place of `/{version}/auth` discovery. */
  readonly authInfo: BcfAuthInfo;
  /** Same-origin relay the server is reached through. */
  readonly relay: { readonly upstream: string; readonly path: string };
  /** No `current-user` endpoint: the account is read from the access token. */
  readonly identityFromToken: true;
  /** How topic lists page (the server ignores `$skip`). */
  readonly topicPaging: 'modified-date';
  /**
   * Topic types that keep a `topic_status`. The server accepts a status with
   * any other type and stores it as null, silently, so publication withholds
   * it and says so. Absent: every type keeps its status.
   */
  readonly topicStatusTypes?: readonly string[];
}

const BUILDAGIL_API = 'https://openapi.buildagil.com';

const PROFILES: ReadonlyMap<string, BcfServerProfile> = new Map([
  [BUILDAGIL_API, {
    version: '1.0',
    authInfo: {
      oauth2_auth_url: `${BUILDAGIL_API}/oauth2/authorize`,
      oauth2_token_url: `${BUILDAGIL_API}/oauth2/token`,
    },
    relay: { upstream: BUILDAGIL_API, path: '/api/buildagil' },
    identityFromToken: true,
    topicPaging: 'modified-date',
    // The known rule, not data from the server: it reveals the statuses a type
    // allows only per existing topic (`authorization.topic_status`), never
    // per type up front. Measured on the live API, 2026-11-02.
    topicStatusTypes: ['Task', 'Model Issue', 'Documentation Log', 'Incident Log', 'Deficiency Log'],
  }],
]);

/** The profile for a server URL (exact, trailing slashes ignored), or null. */
export function bcfServerProfile(serverUrl: string): BcfServerProfile | null {
  return PROFILES.get(serverUrl.trim().replace(/\/+$/, '')) ?? null;
}

/**
 * A fetch that sends the profile's upstream URLs to its same-origin relay.
 * Anything else is refused: a profiled connection has no other host to reach,
 * so a URL outside the upstream is a bug, not a request to make.
 */
export function relayedFetch(profile: BcfServerProfile, base: FetchLike = (input, init) => fetch(input, init)): FetchLike {
  return (input, init) => {
    const url = String(input);
    const relayed = applyRelay(url, profile.relay, window.location.origin);
    if (relayed === url) {
      return Promise.reject(new Error(`This BCF server is reached only through ${profile.relay.path}, not ${url}`));
    }
    return base(relayed, { ...init, credentials: 'omit' });
  };
}

/**
 * The signed-in account from an access token's claims, for servers without a
 * `current-user` endpoint. Display and session keying only: the claims are
 * decoded, not verified; the server verifies the token on every request.
 */
export function userIdFromAccessToken(token: string): string {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('The access token carries no account details.');
  let claims: Record<string, unknown>;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))));
    claims = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    throw new Error(`The access token carries no readable account details (${error instanceof Error ? error.name : 'unknown'}).`);
  }
  for (const key of ['email', 'upn', 'preferred_username', 'oid', 'sub']) {
    const value = claims[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  throw new Error('The access token names no account.');
}
