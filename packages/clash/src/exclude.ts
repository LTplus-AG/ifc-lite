/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ExclusionSet } from './types.js';

/**
 * Length-prefix encode a string so concatenations are unambiguous regardless of
 * the content (model ids, IfcGUIDs and USD prim paths are all free-form). All
 * output is printable ASCII — no separators to collide with, no control bytes.
 */
function encode(value: string): string {
  return `${value.length}:${value}`;
}

/**
 * Federation-safe element identity: a model-qualified key. Element identity is
 * `(model, key)` everywhere in the engine, so exclusions must be namespaced by
 * model too — otherwise two models that both contain element "42" collide and
 * can hide valid cross-model clashes.
 */
export function qualifiedKey(model: string, key: string): string {
  return encode(model) + encode(key);
}

/** Order-independent key for a pair of (already model-qualified) element keys. */
export function pairKey(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return encode(lo) + encode(hi);
}

/** Build an exclusion set from qualified-key pairs (voids/hosts/assemblies). */
export function makeExclusionSet(pairs: Iterable<[string, string]> = []): ExclusionSet {
  const set = new Set<string>();
  for (const [a, b] of pairs) {
    set.add(pairKey(a, b));
  }
  return set;
}

/** Whether the pair (a, b) — both model-qualified keys — is excluded. */
export function isExcluded(set: ExclusionSet, a: string, b: string): boolean {
  return set.has(pairKey(a, b));
}
