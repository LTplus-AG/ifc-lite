/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exclusions in a run document: the engine's exclusion set (void/host,
 * aggregates) recorded as slot-qualified pairs, and the user's exclusion
 * rules, so a comparison can tell "not detected" from "not looked at".
 */

import { decodeQualifiedPair, pairKey } from './exclude.js';
import { clashElementIdentity } from './object-identity.js';
import type { ClashRunEndpoint, ClashRunFinding } from './run-document.js';
import type { Clash, ExclusionSet } from './types.js';

/** Slot-qualified, order-independent id of an excluded element pair. */
export function slotExclusionId(a: readonly [string, string], b: readonly [string, string]): string {
  const ea = JSON.stringify(a);
  const eb = JSON.stringify(b);
  return JSON.stringify(ea < eb ? [a, b] : [b, a]);
}

/**
 * A user exclusion rule. `type`: any clash involving that IFC class.
 * `typePair`: clashes between the two classes, either order. `elementKeyPair`:
 * clashes between the two elements, by `clashElementIdentity` (no slot: the
 * rule covers that GlobalId pair wherever it occurs, as in the viewer).
 */
export type ClashRunExclusionRule =
  | { kind: 'type'; type: string }
  | { kind: 'typePair'; a: string; b: string }
  | { kind: 'elementKeyPair'; a: string; b: string };

/** A run's user exclusion rules as lookup sets, built once: each covered-check is O(1), not O(rules). */
export interface ClashRunExclusionIndex {
  types: Set<string>;
  typePairs: Set<string>;
  elementPairs: Set<string>;
}

/** Index user exclusion rules by kind (type, order-independent type pair, element pair). */
export function indexExclusionRules(rules: readonly ClashRunExclusionRule[]): ClashRunExclusionIndex {
  const index: ClashRunExclusionIndex = { types: new Set(), typePairs: new Set(), elementPairs: new Set() };
  for (const rule of rules) {
    if (rule.kind === 'type') index.types.add(rule.type);
    else (rule.kind === 'typePair' ? index.typePairs : index.elementPairs).add(pairKey(rule.a, rule.b));
  }
  return index;
}

/** Whether an indexed rule covers a clash between elements with these types and identities. */
export function exclusionIndexCovers(
  index: ClashRunExclusionIndex,
  a: { type: string | undefined; identity: string },
  b: { type: string | undefined; identity: string },
): boolean {
  // An unknown type (`undefined`) matches no type rule; a type pair needs both types known.
  return (a.type !== undefined && index.types.has(a.type)) || (b.type !== undefined && index.types.has(b.type))
    || (index.typePairs.size > 0 && a.type !== undefined && b.type !== undefined && index.typePairs.has(pairKey(a.type, b.type)))
    || (index.elementPairs.size > 0 && index.elementPairs.has(pairKey(a.identity, b.identity)));
}

/** Element types a run recorded for its type rules: slot -> key -> type. See `ClashRunManifest.exclusionTypes`. */
export type ClashRunExclusionTypes = Record<string, Record<string, string>>;

/** Whether a rule needs element types to be judged. */
export const isTypeRule = (rule: ClashRunExclusionRule): boolean => rule.kind !== 'elementKeyPair';

/**
 * Whether any of `rules` covers a finding (whose endpoints have stable keys).
 * Pass `types` to judge another run's rules: an element's type can change
 * between model versions, so a run's type rules are evaluated against the
 * types THAT run recorded, never the finding's own. A key missing from
 * `types` had no type any rule names.
 */
export function matchesExclusionRule(
  rules: readonly ClashRunExclusionRule[] | ClashRunExclusionIndex,
  finding: Pick<ClashRunFinding, 'a' | 'b'>,
  types?: ClashRunExclusionTypes,
): boolean {
  const index = Array.isArray(rules) ? indexExclusionRules(rules) : (rules as ClashRunExclusionIndex);
  if (index.types.size === 0 && index.typePairs.size === 0 && index.elementPairs.size === 0) return false;
  const typeOf = (end: ClashRunEndpoint): string | undefined => {
    if (!types) return end.type;
    const bySlot = Object.hasOwn(types, end.slot) ? types[end.slot] : undefined;
    return bySlot && Object.hasOwn(bySlot, end.key) ? bySlot[end.key] : undefined;
  };
  const side = (end: ClashRunEndpoint) => ({ type: typeOf(end), identity: clashElementIdentity({ key: end.key, ref: 0 }) });
  const a = side(finding.a);
  const b = side(finding.b);
  return exclusionIndexCovers(index, a, b);
}

/**
 * Translate an engine exclusion set to slot-qualified pair ids. A pair on a
 * model bound to no slot concerns no recorded finding and is dropped; a pair
 * that does not decode (built with another encoding) makes the record unknown,
 * since it could hide any pair.
 */
export function recordExclusions(exclusions: ExclusionSet, slotByModel: ReadonlyMap<string, string>): string[] | null {
  const ids = new Set<string>();
  for (const pair of exclusions) {
    const decoded = decodeQualifiedPair(pair);
    if (!decoded) return null;
    const [a, b] = decoded;
    const slotA = slotByModel.get(a.model);
    const slotB = slotByModel.get(b.model);
    if (slotA !== undefined && slotB !== undefined) ids.add(slotExclusionId([slotA, a.key], [slotB, b.key]));
  }
  return [...ids].sort();
}

/** The run's types for the elements its type rules name (see `ClashRunManifest.exclusionTypes`). */
export function recordExclusionTypes(
  rules: readonly ClashRunExclusionRule[],
  elements: Iterable<{ model: string; key: string; tag: string }> | undefined,
  clashes: readonly Clash[],
  slotByModel: ReadonlyMap<string, string>,
): ClashRunExclusionTypes | null {
  const named = new Set(rules.filter(isTypeRule).flatMap((rule) => (rule.kind === 'type' ? [rule.type] : rule.kind === 'typePair' ? [rule.a, rule.b] : [])));
  if (named.size === 0) return {};
  if (!elements) return null;
  const bySlot = new Map<string, Map<string, string>>();
  const add = (model: string, key: string, tag: string) => {
    const slot = slotByModel.get(model);
    if (slot === undefined || !named.has(tag)) return;
    const keys = bySlot.get(slot) ?? new Map<string, string>();
    keys.set(key, tag);
    bySlot.set(slot, keys);
  };
  for (const element of elements) add(element.model, element.key, element.tag);
  for (const clash of clashes) { add(clash.a.model, clash.a.key, clash.a.tag); add(clash.b.model, clash.b.key, clash.b.tag); }
  return Object.fromEntries([...bySlot.keys()].sort().map((slot) =>
    [slot, Object.fromEntries([...bySlot.get(slot)!].sort(([x], [y]) => (x < y ? -1 : 1)))]));
}
