// SPDX-License-Identifier: MPL-2.0
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Conservative override candidates, never a replacement for STEP grammar.
 * Quoted labels containing #id may over-count; the effective reader verifies
 * them. Numeric coordinates and measures cannot introduce STEP references. */
export function overlayReferenceCandidates(values: Iterable<unknown>): string[] {
  const refs = new Set<string>(), visited = new Set<unknown[]>(), pending = [...values];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value) && !visited.has(value)) {
      visited.add(value); for (const child of value) pending.push(child);
    } else if (typeof value === 'string') {
      for (const match of value.matchAll(/#([0-9]+)/g)) refs.add(`#${Number(match[1])}`);
    }
  }
  return [...refs];
}
