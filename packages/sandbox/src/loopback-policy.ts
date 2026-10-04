/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Capability } from '@ifc-lite/extensions';

const HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Recognize literal loopback HTTP before URL canonicalization can hide alternate IP spellings. */
export function loopbackHttpOrigin(endpoint: string): string | undefined {
  if (typeof endpoint !== 'string') return undefined;
  for (const character of endpoint) if (character.charCodeAt(0) <= 32 || character === '\\') return undefined;
  if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?(?=[/?#]|$)/u.test(endpoint)) return undefined;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'http:' && HOSTS.has(url.hostname) && !url.username && !url.password ? url.origin : undefined;
  } catch { return undefined; }
}
/** The existing network.fetch capability shape, restricted to one exact loopback host. */
export function createLoopbackHostGrant(host: string): Capability {
  if (!HOSTS.has(host)) throw new Error('Loopback HTTP requires an exact literal loopback host grant');
  return { raw: `network.fetch:${host}`, scope: 'network', action: 'fetch',
    target: { raw: host, isUniversalWildcard: false, segments: [{ kind: 'literal', value: host }] } };
}
/** HTTPS is the default. HTTP additionally needs a canonical exact origin, including its port. */
export function assertNetworkEndpoint(endpoint: string, authorizedOrigin?: string): void {
  const url = new URL(endpoint);
  if (authorizedOrigin !== undefined && (loopbackHttpOrigin(authorizedOrigin) !== authorizedOrigin || url.origin !== authorizedOrigin)) {
    throw new Error('Loopback HTTP authorization must match the exact canonical origin');
  }
  if (url.protocol === 'https:' && authorizedOrigin === undefined) return;
  if (url.protocol === 'http:' && authorizedOrigin !== undefined && loopbackHttpOrigin(endpoint) === authorizedOrigin) return;
  throw new Error(`only https: URLs are permitted, got "${url.protocol}" without an explicit exact loopback HTTP origin authorization`);
}
