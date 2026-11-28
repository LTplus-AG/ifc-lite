/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compare two stored clash runs (coordination rounds) and carry review
 * decisions from one to the next.
 *
 * This is `compareClashRuns` (lifecycle.ts) for run documents. There the hard
 * part is that a review key drops the per-load model id and so repeats within
 * a run; here every key is slot-qualified, so a key names one element pair in
 * one slot pair and the occurrence pairing reduces to counting. What run
 * documents add is the manifest, which lets the comparison refuse to guess:
 * a finding only becomes "no longer detected" when the next run verifiably
 * re-examined both its elements under the same rule semantics. Otherwise it
 * is "not comparable", with the reasons, and never silently counted as fixed.
 *
 * Detection change (added / persistent / no longer detected / not comparable)
 * is kept apart from the human review status (open / resolved / accepted):
 * the comparison never reads or writes a review, and `carryForwardReviews`
 * consumes the comparison rather than the other way round.
 */

import { parseClashReviewKey } from './review.js';
import type { ClashRunDocument, ClashRunFinding } from './run-document.js';
import type { ClashReview } from './types.js';

/** Why a finding cannot be placed in added / persistent / no longer detected. */
export type ClashRunNotComparableReason =
  /** A side has no stable identity: its GlobalId is repeated within its slot. */
  | 'ambiguous-identity'
  /** A side's slot is not part of the other run. */
  | 'slot-not-in-other-run'
  /** The rule did not run in the other run. */
  | 'rule-not-in-other-run'
  /** The rule ran under different semantics (selectors, tolerance, ...) with the same id. */
  | 'rule-revision-changed'
  /** The next run no longer contains a side's element (deleted, or its GlobalId re-minted). */
  | 'element-not-examined'
  /** The next run's coverage does not list the elements it examined, and a slot model changed. */
  | 'coverage-not-recorded'
  /** The other run hit its candidate cap, so absence there proves nothing. */
  | 'run-truncated';

/** How a slot changed between the two runs. `unpinned`: one side has no sha256 to compare. */
export type ClashRunSlotChange = 'unchanged' | 'model-changed' | 'unpinned' | 'added' | 'removed';
export type ClashRunRuleChange = 'unchanged' | 'revision-changed' | 'added' | 'removed';

export interface ClashRunNotComparable {
  /** Which run the finding is from. */
  side: 'previous' | 'next';
  finding: ClashRunFinding;
  reasons: ClashRunNotComparableReason[];
}

export interface ClashRunComparison {
  /** Detected in `next` only. */
  added: ClashRunFinding[];
  /** Detected in both: the `next` finding, and the `previous` one it matched. */
  persistent: Array<{ previous: ClashRunFinding; next: ClashRunFinding }>;
  /** Detected in `previous`, and `next` verifiably re-examined both elements under the same rule. */
  noLongerDetected: ClashRunFinding[];
  notComparable: ClashRunNotComparable[];
  slots: Record<string, ClashRunSlotChange>;
  rules: Record<string, ClashRunRuleChange>;
  summary: { added: number; persistent: number; noLongerDetected: number; notComparable: number };
}

const byId = (x: ClashRunFinding, y: ClashRunFinding) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

function slotChanges(previous: ClashRunDocument, next: ClashRunDocument): Record<string, ClashRunSlotChange> {
  const before = new Map(previous.manifest.slots.map((s) => [s.slot, s.sha256]));
  const after = new Map(next.manifest.slots.map((s) => [s.slot, s.sha256]));
  const out: Record<string, ClashRunSlotChange> = {};
  for (const slot of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (!after.has(slot)) out[slot] = 'removed';
    else if (!before.has(slot)) out[slot] = 'added';
    else {
      const [a, b] = [before.get(slot), after.get(slot)];
      out[slot] = a == null || b == null ? 'unpinned' : a === b ? 'unchanged' : 'model-changed';
    }
  }
  return out;
}

function ruleChanges(previous: ClashRunDocument, next: ClashRunDocument): Record<string, ClashRunRuleChange> {
  const before = new Map(previous.manifest.rules.items.map((r) => [r.id, r.revision]));
  const after = new Map(next.manifest.rules.items.map((r) => [r.id, r.revision]));
  const out: Record<string, ClashRunRuleChange> = {};
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (!after.has(id)) out[id] = 'removed';
    else if (!before.has(id)) out[id] = 'added';
    else out[id] = before.get(id) === after.get(id) ? 'unchanged' : 'revision-changed';
  }
  return out;
}

function groupByKey(findings: readonly ClashRunFinding[]): { keyed: Map<string, ClashRunFinding[]>; keyless: ClashRunFinding[] } {
  const keyed = new Map<string, ClashRunFinding[]>();
  const keyless: ClashRunFinding[] = [];
  for (const finding of findings) {
    if (finding.key === null) { keyless.push(finding); continue; }
    const group = keyed.get(finding.key);
    if (group) group.push(finding);
    else keyed.set(finding.key, [finding]);
  }
  return { keyed, keyless };
}

/**
 * Compare a previous run with a next one. Pure and deterministic; every
 * output list is sorted by finding id.
 */
export function compareClashRunDocuments(previous: ClashRunDocument, next: ClashRunDocument): ClashRunComparison {
  const slots = slotChanges(previous, next);
  const rules = ruleChanges(previous, next);
  const out: ClashRunComparison = { added: [], persistent: [], noLongerDetected: [], notComparable: [], slots, rules,
    summary: { added: 0, persistent: 0, noLongerDetected: 0, notComparable: 0 } };

  const otherRunReasons = (finding: ClashRunFinding, other: ClashRunDocument, side: 'previous' | 'next') => {
    const reasons: ClashRunNotComparableReason[] = [];
    const otherSlots = new Set(other.manifest.slots.map((s) => s.slot));
    if (!otherSlots.has(finding.a.slot) || !otherSlots.has(finding.b.slot)) reasons.push('slot-not-in-other-run');
    const otherRule = other.manifest.rules.items.find((r) => r.id === finding.rule);
    if (!otherRule) reasons.push('rule-not-in-other-run');
    else if (otherRule.revision !== finding.ruleRevision) reasons.push('rule-revision-changed');
    if (other.manifest.truncated) reasons.push('run-truncated');
    // A key the other run saw repeated in its slot has no identity there either.
    for (const end of [finding.a, finding.b]) {
      if (other.manifest.ambiguousKeys[end.slot]?.includes(end.key) && !reasons.includes('ambiguous-identity')) reasons.push('ambiguous-identity');
    }
    if (side === 'previous' && reasons.length === 0) reasons.push(...examinedReasons(finding, other, slots));
    return reasons;
  };
  const notComparable = (side: 'previous' | 'next', finding: ClashRunFinding, reasons: ClashRunNotComparableReason[]) =>
    out.notComparable.push({ side, finding, reasons });

  const classifyGone = (finding: ClashRunFinding) => {
    const reasons = otherRunReasons(finding, next, 'previous');
    if (reasons.length === 0) out.noLongerDetected.push(finding);
    else notComparable('previous', finding, reasons);
  };

  const before = groupByKey(previous.findings);
  const after = groupByKey(next.findings);
  for (const finding of before.keyless) notComparable('previous', finding, ['ambiguous-identity']);
  for (const finding of after.keyless) notComparable('next', finding, ['ambiguous-identity']);

  for (const [key, nextGroup] of after.keyed) {
    const prevGroup = before.keyed.get(key) ?? [];
    const paired = Math.min(prevGroup.length, nextGroup.length);
    for (let i = 0; i < paired; i += 1) out.persistent.push({ previous: prevGroup[i], next: nextGroup[i] });
    for (const finding of nextGroup.slice(paired)) {
      const reasons = otherRunReasons(finding, previous, 'next');
      if (reasons.length === 0) out.added.push(finding);
      else notComparable('next', finding, reasons);
    }
    for (const finding of prevGroup.slice(paired)) classifyGone(finding);
  }
  for (const [key, prevGroup] of before.keyed) if (!after.keyed.has(key)) prevGroup.forEach(classifyGone);


  out.added.sort(byId);
  out.noLongerDetected.sort(byId);
  out.persistent.sort((x, y) => byId(x.next, y.next));
  out.notComparable.sort((x, y) => (x.side === y.side ? byId(x.finding, y.finding) : x.side === 'previous' ? -1 : 1));
  out.summary = { added: out.added.length, persistent: out.persistent.length,
    noLongerDetected: out.noLongerDetected.length, notComparable: out.notComparable.length };
  return out;
}

/**
 * For a previous-run finding the next run did not report: did the next run
 * re-examine both elements? An unchanged pinned model under an unchanged rule
 * is re-examined by construction; otherwise the next run's coverage must list
 * both keys in their slots.
 */
function examinedReasons(finding: ClashRunFinding, next: ClashRunDocument, slots: Record<string, ClashRunSlotChange>): ClashRunNotComparableReason[] {
  if (slots[finding.a.slot] === 'unchanged' && slots[finding.b.slot] === 'unchanged') return [];
  const coverage = next.manifest.coverage.find((c) => c.rule === finding.rule);
  if (!coverage || coverage.examined === null) return ['coverage-not-recorded'];
  const examined = coverage.examined;
  const seen = (end: ClashRunFinding['a']) => examined[end.slot]?.includes(end.key) === true;
  return seen(finding.a) && seen(finding.b) ? [] : ['element-not-examined'];
}

/** Why a decision did not reach the next run. */
export type ClashReviewNotCarriedReason =
  /** The pair was not detected again. The decision stays with the previous run. */
  | 'no-longer-detected'
  /** The pair could not be compared; see `notComparable`. */
  | 'not-comparable'
  /** A legacy (unqualified) key matches no finding, or more than one, in the next run. */
  | 'legacy-key-unmatched'
  /** A slot-qualified decision for the same next finding took precedence over this legacy one. */
  | 'superseded'
  /** The key is in neither run, or unreadable. */
  | 'unknown-key';

export interface ClashReviewCarryForward {
  /** Decisions for the next run, by its slot-qualified finding key. */
  reviews: Record<string, ClashReview>;
  carried: Array<{ from: string; to: string; review: ClashReview; via: 'key' | 'legacy-key' }>;
  notCarried: Array<{ key: string; review: ClashReview; reason: ClashReviewNotCarriedReason; reasons?: ClashRunNotComparableReason[] }>;
  /** Carried `resolved` decisions whose pair the next run still detects: worth a second look. */
  resolvedButStillDetected: string[];
}

/**
 * Apply review decisions taken on `previous` to `next`, by key. `decisions`
 * defaults to the reviews recorded on `previous`'s findings. Slot-qualified
 * keys carry only to a `persistent` match; a legacy key (from a store that
 * predates slots) carries only when exactly one comparable next finding has
 * it as its `legacyKey`. Everything else is reported in `notCarried`.
 */
export function carryForwardReviews(
  previous: ClashRunDocument,
  next: ClashRunDocument,
  decisions?: Readonly<Record<string, ClashReview>>,
  comparison: ClashRunComparison = compareClashRunDocuments(previous, next),
): ClashReviewCarryForward {
  const source: Record<string, ClashReview> = decisions ? { ...decisions } : {};
  if (!decisions) for (const f of previous.findings) if (f.key !== null && f.review) source[f.key] = f.review;

  const persistentByPrevKey = new Map<string, ClashRunFinding[]>();
  for (const { previous: p, next: n } of comparison.persistent) {
    const list = persistentByPrevKey.get(p.key!) ?? [];
    list.push(n);
    persistentByPrevKey.set(p.key!, list);
  }
  const goneKeys = new Set(comparison.noLongerDetected.map((f) => f.key));
  const notComparableByKey = new Map<string, ClashRunNotComparableReason[]>();
  for (const entry of comparison.notComparable) {
    for (const key of [entry.finding.key, entry.finding.legacyKey]) {
      if (key !== null && !notComparableByKey.has(key)) notComparableByKey.set(key, entry.reasons);
    }
  }
  const nextByLegacy = new Map<string, ClashRunFinding[]>();
  for (const f of next.findings) {
    const list = nextByLegacy.get(f.legacyKey) ?? [];
    list.push(f);
    nextByLegacy.set(f.legacyKey, list);
  }

  const result: ClashReviewCarryForward = { reviews: {}, carried: [], notCarried: [], resolvedButStillDetected: [] };
  const carry = (from: string, to: string, review: ClashReview, via: 'key' | 'legacy-key') => {
    result.reviews[to] = { ...review };
    result.carried.push({ from, to, review: { ...review }, via });
    if (review.status === 'resolved') result.resolvedButStillDetected.push(to);
  };
  const comparableNext = new Set([...persistentByPrevKey.values()].flat().map((f) => f.id).concat(comparison.added.map((f) => f.id)));

  const keys = Object.keys(source).sort();
  const legacy: string[] = [];
  for (const key of keys) {
    const review = source[key];
    const parsed = parseClashReviewKey(key);
    if (parsed?.format === 'legacy') { legacy.push(key); continue; }
    const matches = persistentByPrevKey.get(key);
    if (parsed && matches) {
      for (const to of new Set(matches.map((f) => f.key!))) carry(key, to, review, 'key');
    } else if (goneKeys.has(key)) result.notCarried.push({ key, review, reason: 'no-longer-detected' });
    else if (notComparableByKey.has(key)) result.notCarried.push({ key, review, reason: 'not-comparable', reasons: notComparableByKey.get(key) });
    else result.notCarried.push({ key, review, reason: 'unknown-key' });
  }
  // Legacy keys second, so a slot-qualified decision for the same finding wins.
  for (const key of legacy) {
    const review = source[key];
    const all = nextByLegacy.get(key) ?? [];
    const target = all.length === 1 && all[0].key !== null && comparableNext.has(all[0].id) ? all[0].key : null;
    if (target !== null && Object.hasOwn(result.reviews, target)) result.notCarried.push({ key, review, reason: 'superseded' });
    else if (target !== null) carry(key, target, review, 'legacy-key');
    else if (notComparableByKey.has(key)) result.notCarried.push({ key, review, reason: 'not-comparable', reasons: notComparableByKey.get(key) });
    else result.notCarried.push({ key, review, reason: 'legacy-key-unmatched' });
  }
  result.resolvedButStillDetected = [...new Set(result.resolvedButStillDetected)].sort();
  return result;
}
