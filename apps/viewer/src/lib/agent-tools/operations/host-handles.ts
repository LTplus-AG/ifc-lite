/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Make room for one more host-owned handle (run, candidate) by dropping the oldest
 * one `canEvict` allows. Handles are never freed by the agent, so a hard cap would
 * lock the host out.
 */
export function evictOldest<K, V>(handles: Map<K, V>, cap: number, canEvict: (handle: V) => boolean = () => true): void {
  for (const [key, handle] of handles) {
    if (handles.size < cap) return;
    if (canEvict(handle)) handles.delete(key);
  }
}
