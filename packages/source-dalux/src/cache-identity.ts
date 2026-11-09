/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Client lifetimes isolate caches without retaining or hashing credentials.
let nextIdentity = 0n;
export function cacheIdentity(): string {
  return (++nextIdentity).toString();
}
