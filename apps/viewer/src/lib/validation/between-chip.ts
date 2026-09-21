/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `between` display folding for the rule editor (#5138 plan §6's operator
 * table): the persisted `RuleBlock.groups` never gains a `between` rule
 * kind — it stays a plain `gte` rule plus a plain `lte` rule on the same
 * subject, exactly the vocabulary `readSubject`/`filter-ops.ts` already
 * understand (plan §3, §4). "Between" only exists here, as a pure display
 * transform the editor applies on load (fold) and reverses on save
 * (unfold), so `RuleBlockEditor` can show ONE range chip instead of two
 * rows that happen to share a subject.
 *
 * Only `property` / `quantity` / `attribute` rules fold — the three
 * element-requirement kinds whose op is `gte`/`lte` at all (ELEMENT_
 * REQUIREMENT_KINDS in `rule-set-io-requirement.ts`; `name`/`type`/
 * `parent`/`material`/`classification` use `StringOp`, `ifcType`/
 * `predefinedType` use `SetOp` — none of those has a numeric bound to
 * pair).
 */

import type { FilterRule } from '../search/filter-rules.js';

type Betweenable = Extract<FilterRule, { kind: 'property' | 'quantity' | 'attribute' }>;

export interface BetweenChip {
  kind: 'between';
  /** The `gte` rule — its `value` is the range minimum. */
  min: Betweenable;
  /** The `lte` rule on the identical subject — its `value` is the maximum. */
  max: Betweenable;
}

export type FoldedRule = FilterRule | BetweenChip;

export function isBetweenChip(row: FoldedRule): row is BetweenChip {
  return row.kind === 'between';
}

/** Same subject, ignoring op/value: what makes a `gte` and an `lte` rule
 *  "the same range" rather than two unrelated bounds. `null` for rule
 *  kinds that never fold (including every non-betweenable kind, which is
 *  every kind besides the three above). */
function subjectKey(rule: FilterRule): string | null {
  if (rule.kind === 'quantity') return `quantity\u0000${rule.setName}\u0000${rule.quantityName}`;
  if (rule.kind === 'property') return `property\u0000${rule.setName}\u0000${rule.propertyName}`;
  if (rule.kind === 'attribute') return `attribute\u0000${rule.name}`;
  return null;
}

function isBetweenable(rule: FilterRule): rule is Betweenable {
  return rule.kind === 'property' || rule.kind === 'quantity' || rule.kind === 'attribute';
}

/**
 * Merge `gte`/`lte` pairs on the identical subject into one `BetweenChip`,
 * regardless of which one appears first. A subject with only a `gte`, only
 * a `lte`, or more than one of either, is left as plain rules — folding
 * only ever removes exactly two entries and adds exactly one, never
 * guesses which of several candidates pairs with which.
 *
 * Pairing happens in a PASS OF ITS OWN, before anything is written to
 * `out`: a single combined pass that pushed a `lte` immediately (because
 * it isn't itself a `gte`) and only later discovered, at its `gte`
 * partner's index, that the two pair up, would leave that `lte` in `out`
 * TWICE — once as the plain rule already pushed, once folded inside the
 * chip — so `[lte(300), gte(100)]` (partner before the `gte` that finds
 * it) silently produced three rules on unfold instead of two. Deciding
 * every pair up front means the emitting pass never has to un-push
 * something it already committed.
 */
export function foldBetweenPairs(rules: readonly FilterRule[]): FoldedRule[] {
  const consumed = new Set<number>();
  // gte index -> lte index, in both directions, so the emitting pass can
  // look a consumed index up either way and always find its partner.
  const partnerOf = new Map<number, number>();

  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i];
    if (consumed.has(i) || !isBetweenable(rule) || rule.op !== 'gte') continue;
    const key = subjectKey(rule);
    const partnerIndex = rules.findIndex(
      (candidate, j) =>
        j !== i &&
        !consumed.has(j) &&
        isBetweenable(candidate) &&
        candidate.op === 'lte' &&
        subjectKey(candidate) === key,
    );
    if (partnerIndex >= 0) {
      consumed.add(i);
      consumed.add(partnerIndex);
      partnerOf.set(i, partnerIndex);
      partnerOf.set(partnerIndex, i);
    }
  }

  const out: FoldedRule[] = [];
  const emitted = new Set<number>();
  for (let i = 0; i < rules.length; i += 1) {
    if (!consumed.has(i)) {
      out.push(rules[i]);
      continue;
    }
    if (emitted.has(i)) continue; // the chip already went out at its partner's index
    const partnerIndex = partnerOf.get(i) as number;
    emitted.add(i);
    emitted.add(partnerIndex);
    const gteIndex = rules[i].op === 'gte' ? i : partnerIndex;
    const lteIndex = gteIndex === i ? partnerIndex : i;
    out.push({ kind: 'between', min: rules[gteIndex] as Betweenable, max: rules[lteIndex] as Betweenable });
  }
  return out;
}

/** Reverses `foldBetweenPairs`: every `BetweenChip` becomes its `min`
 *  (`gte`) rule followed by its `max` (`lte`) rule — the exact shape
 *  `rule-set-io.ts` persists. */
export function unfoldBetweenChips(rows: readonly FoldedRule[]): FilterRule[] {
  const out: FilterRule[] = [];
  for (const row of rows) {
    if (isBetweenChip(row)) {
      out.push(row.min, row.max);
    } else {
      out.push(row);
    }
  }
  return out;
}
