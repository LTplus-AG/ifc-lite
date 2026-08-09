/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Matches a bare domain (`dalux.com`) or a leading-wildcard subdomain pattern
 * (`*.sharepoint.com`) — the two shapes `PluginPermissions.network` and
 * `.publicNetwork` document. Deliberately conservative: no ports, no
 * schemes, no paths — those don't belong in a hostname allowlist entry.
 */
const HOST_PATTERN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export function isValidHostPattern(pattern: string): boolean {
  return HOST_PATTERN_RE.test(pattern);
}
