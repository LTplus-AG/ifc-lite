/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * User-defined clash exclusions.
 *
 * The engine already skips pairs the IFC itself declares non-clashing (an
 * opening in its host, a filler in its opening, siblings of one
 * `IfcRelAggregates`) — see `exclusions` in `@ifc-lite/clash`. What it cannot
 * know is which *designed* interpenetrations a given project considers normal:
 * ballast embedding sleepers, stacked pavement courses, a girder cast into a
 * deck. Those are decisions about a model, so they belong to the user.
 *
 * Three granularities, because one is not enough:
 * - `typeAny`     — every clash with at least ONE side of a given IFC class.
 *                   "Pavement slabs meeting anything is by design."
 * - `typePair`    — every clash between two IFC classes, in either order. One
 *                   rule clears a whole systematic family in a single action.
 * - `elementPair` — exactly the two elements of one clash, and nothing else.
 *
 * `typeAny` exists because the intent "ignore anything touching an `IfcSlab`"
 * is ONE decision but needs one `typePair` rule per counterpart class actually
 * present — a count that grows with the federation, not with the intent. On one
 * infrastructure model that was 3 rules for `IfcSlab` alone.
 *
 * Element identity is **model-qualified** (`qualifiedKey`), so in a federated
 * set two models that happen to share an element key cannot suppress each
 * other's clashes. TYPE rules carry no model qualification and are therefore
 * deliberately cross-model: an IFC class means the same thing in every file.
 * The pair kinds compare through `pairKey`, which is order-independent and
 * length-prefixed, so `A × B` and `B × A` are one rule and no separator can be
 * forged out of a name; `typeAny` gets its order-independence from testing both
 * sides of the clash against the one class it names.
 *
 * Rules are applied as a FILTER over a completed result rather than being fed
 * to the engine's `ExclusionSet`. That is deliberate: it is what lets the panel
 * say how many clashes each rule is suppressing, and lets a rule be toggled or
 * removed without re-running detection.
 */

import { pairKey, qualifiedKey, summarizeClashes, type Clash, type ClashElementRef, type ClashResult } from '@ifc-lite/clash';

/** Which granularity a rule matches at. */
export type ClashExclusionKind = 'typeAny' | 'typePair' | 'elementPair';

/** A user's "these two are allowed to overlap" decision. */
export interface ClashExclusionRule {
  id: string;
  kind: ClashExclusionKind;
  /**
   * Side A. `typeAny`/`typePair`: an IFC class name. `elementPair`: a
   * `qualifiedKey`.
   */
  a: string;
  /**
   * Side B, same encoding as {@link ClashExclusionRule.a}. A `typeAny` rule has
   * only one side, and repeats it here: the rule then satisfies the same
   * non-empty `a`/`b` shape every reader and the stored-rule validator expect,
   * and its `pairKey` dedup identity is order-independent by construction.
   */
  b: string;
  /** What the user sees in the exclusions list. */
  label: string;
  /** Off keeps the rule (and its count) without suppressing anything. */
  enabled: boolean;
  /** Epoch-ms, so the list can show newest-first. */
  createdAt: number;
}

/** Longest label we store; a rule is an identity, not a place for prose. */
export const MAX_EXCLUSION_LABEL = 160;

function label(a: string, b: string): string {
  return `${a} × ${b}`.slice(0, MAX_EXCLUSION_LABEL);
}

/** Display name of one side of an element-pair rule: `Name` if any, else the key. */
function elementLabel(el: ClashElementRef): string {
  return el.name?.trim() || el.key;
}

/**
 * Order-independent identity of a rule, for dedup: the same pair added twice
 * (or added in the other order) is the same rule. `kind` is part of the key so
 * "all IfcBeam × IfcBeam" never collides with a specific beam pair.
 */
export function exclusionRuleKey(rule: ClashExclusionRule): string {
  return `${rule.kind}:${pairKey(rule.a, rule.b)}`;
}

function newId(): string {
  return `excl-${crypto.randomUUID()}`;
}

/**
 * "Never report anything against `tag`" — the widest rule the panel offers.
 *
 * Deliberately a distinct `kind` rather than a `'*'` sentinel in `a`/`b`: the
 * kind keeps every reader's `a` field meaning exactly one thing (an IFC class
 * name), makes the dedup key distinguish `typeAny('IfcBeam')` from
 * `typePair('IfcBeam','IfcBeam')`, and lets a build that predates this kind
 * reject the stored rule outright instead of listing an entry that silently
 * suppresses nothing.
 */
export function typeAnyExclusion(tag: string): ClashExclusionRule {
  return {
    id: newId(),
    kind: 'typeAny',
    a: tag,
    b: tag,
    label: label(tag, 'anything'),
    enabled: true,
    createdAt: Date.now(),
  };
}

/** "Never report `tagA` against `tagB`" — clears a whole systematic family. */
export function typePairExclusion(tagA: string, tagB: string): ClashExclusionRule {
  return {
    id: newId(),
    kind: 'typePair',
    a: tagA,
    b: tagB,
    label: label(tagA, tagB),
    enabled: true,
    createdAt: Date.now(),
  };
}

/** "Never report exactly these two elements" — nothing else is affected. */
export function elementPairExclusion(a: ClashElementRef, b: ClashElementRef): ClashExclusionRule {
  return {
    id: newId(),
    kind: 'elementPair',
    a: qualifiedKey(a.model, a.key),
    b: qualifiedKey(b.model, b.key),
    label: label(elementLabel(a), elementLabel(b)),
    enabled: true,
    createdAt: Date.now(),
  };
}

/** Whether `rule` covers the clash between elements `a` and `b` (either order). */
export function exclusionMatches(rule: ClashExclusionRule, a: ClashElementRef, b: ClashElementRef): boolean {
  // One-sided: either side carrying the class is enough, which is what makes
  // the rule independent of which element the engine put on side A.
  if (rule.kind === 'typeAny') return a.tag === rule.a || b.tag === rule.a;
  const target =
    rule.kind === 'typePair'
      ? pairKey(a.tag, b.tag)
      : pairKey(qualifiedKey(a.model, a.key), qualifiedKey(b.model, b.key));
  return target === pairKey(rule.a, rule.b);
}

export interface ClashExclusionOutcome {
  /** The result with every clash an ENABLED rule covers removed (null in, null out). */
  result: ClashResult | null;
  /**
   * Per-rule id → how many clashes of the INPUT result that rule covers.
   * Counted for disabled rules too (so the user can see what enabling one would
   * cost) and counted independently per rule, so two overlapping rules each
   * report their own reach and the numbers will not sum to `suppressed`.
   */
  counts: Map<string, number>;
  /** How many clashes were actually removed (each removed clash counted once). */
  suppressed: number;
}

/** Filter a result through the user's exclusion rules and report each rule's reach. */
export function applyClashExclusions(
  result: ClashResult | null,
  rules: readonly ClashExclusionRule[],
): ClashExclusionOutcome {
  const counts = new Map<string, number>();
  for (const rule of rules) counts.set(rule.id, 0);
  if (!result) return { result: null, counts, suppressed: 0 };

  const kept: Clash[] = [];
  let suppressed = 0;
  for (const clash of result.clashes) {
    let drop = false;
    for (const rule of rules) {
      if (!exclusionMatches(rule, clash.a, clash.b)) continue;
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
      if (rule.enabled) drop = true;
    }
    if (drop) suppressed += 1;
    else kept.push(clash);
  }
  if (suppressed === 0) return { result, counts, suppressed: 0 };
  // Rebuild the summary rather than patching `total`: the panel and the BCF
  // export read the buckets, and a stale `byTypePair` would still advertise the
  // very type pair the user just excluded.
  return { result: { ...result, clashes: kept, summary: summarizeClashes(kept) }, counts, suppressed };
}
