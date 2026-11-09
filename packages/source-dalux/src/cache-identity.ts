/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Credential-scoped cache key without retaining the raw API key (#8647). */
export function cacheIdentity(credentials: { apiKey: string; node?: string }): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(credentials.apiKey)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return JSON.stringify([credentials.node ?? '', hash.toString(16).padStart(16, '0')]);
}
