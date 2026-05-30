/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ExclusionSet } from './types.js';

const SEP = ' ';

/** Order-independent key for a pair of element keys. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}${SEP}${b}` : `${b}${SEP}${a}`;
}

/** Build an exclusion set from key pairs (voids/hosts/assemblies). */
export function makeExclusionSet(pairs: Iterable<[string, string]> = []): ExclusionSet {
  const set = new Set<string>();
  for (const [a, b] of pairs) {
    set.add(pairKey(a, b));
  }
  return set;
}

/** Whether the pair (a, b) is excluded. */
export function isExcluded(set: ExclusionSet, a: string, b: string): boolean {
  return set.has(pairKey(a, b));
}
