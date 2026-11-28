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
import type { ExclusionSet } from './types.js';

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

/** Whether `rule` covers a clash between elements with these types and identities. */
export function exclusionRuleCovers(rule: ClashRunExclusionRule, a: { type: string; identity: string }, b: { type: string; identity: string }): boolean {
  if (rule.kind === 'type') return a.type === rule.type || b.type === rule.type;
  if (rule.kind === 'typePair') return pairKey(a.type, b.type) === pairKey(rule.a, rule.b);
  return pairKey(a.identity, b.identity) === pairKey(rule.a, rule.b);
}

/** Whether any of `rules` covers a finding (whose endpoints have stable keys). */
export function matchesExclusionRule(rules: readonly ClashRunExclusionRule[], finding: Pick<ClashRunFinding, 'a' | 'b'>): boolean {
  if (rules.length === 0) return false;
  const side = (end: ClashRunEndpoint) => ({ type: end.type, identity: clashElementIdentity({ key: end.key, ref: 0 }) });
  const a = side(finding.a);
  const b = side(finding.b);
  return rules.some((rule) => exclusionRuleCovers(rule, a, b));
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
