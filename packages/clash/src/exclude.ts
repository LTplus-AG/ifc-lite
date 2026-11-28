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
 * Federation-safe key-level exclusion identity. Exclusions are namespaced by
 * model too — otherwise two models that both contain element "42" collide and
 * can hide valid cross-model clashes.
 * A key-level exclusion deliberately covers every occurrence of a repeated
 * key; per-finding user decisions use reference-disambiguated identities.
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

/** Read one length-prefixed field at `at`; `null` when malformed. */
function decodeField(value: string, at: number): { field: string; next: number } | null {
  const colon = value.indexOf(':', at);
  if (colon <= at) return null;
  const digits = value.slice(at, colon);
  if (!/^\d+$/.test(digits)) return null;
  const length = Number(digits);
  const end = colon + 1 + length;
  return end > value.length ? null : { field: value.slice(colon + 1, end), next: end };
}

function decodeTwo(value: string): [string, string] | null {
  const first = decodeField(value, 0);
  const second = first && decodeField(value, first.next);
  return first && second && second.next === value.length ? [first.field, second.field] : null;
}

/**
 * Read a `pairKey` of two `qualifiedKey`s back into its two `{ model, key }`
 * elements, or `null` when it is not one (an exclusion built from some other
 * encoding). Lets a run record WHICH pairs it excluded, not just how many.
 */
export function decodeQualifiedPair(pair: string): [{ model: string; key: string }, { model: string; key: string }] | null {
  const outer = decodeTwo(pair);
  if (!outer) return null;
  const lo = decodeTwo(outer[0]);
  const hi = decodeTwo(outer[1]);
  return lo && hi ? [{ model: lo[0], key: lo[1] }, { model: hi[0], key: hi[1] }] : null;
}
