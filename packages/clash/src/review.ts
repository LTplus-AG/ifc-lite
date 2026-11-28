/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash REVIEW state: the coordination workflow on top of raw detection (#1468).
 *
 * Detection tells you a clash exists; review tells you what the team decided
 * about it (open / resolved / accepted) plus an optional note. This module holds
 * the pure, host-agnostic pieces: a durable key for persisting a review, an
 * aggregation rule for collapsing a group of clashes to one status, and the
 * BCF topic-status mapping used on export. The viewer/CLI own storage and UI.
 */

import type { Clash, ClashReviewStatus } from './types.js';
import { DEFAULT_CLASH_REVIEW_STATUS } from './types.js';
import { clashElementIdentity, clashPairId } from './object-identity.js';

/**
 * A durable, model-independent key for a clash's review state.
 *
 * Unlike `Clash.id`, which embeds the runtime `model` (an ephemeral per-load id
 * in the viewer), this keys purely on the rule id and the two DURABLE element
 * keys (IfcGUID / USD prim path), order-independent. So a review re-attaches to
 * the "same" clash after a page reload, a re-run, or a model revision: the
 * Navisworks "status carries across versions" behaviour the plan calls for.
 * A repeated key within one model is ambiguous: that endpoint's ref participates
 * instead, so a decision never leaks to another source object. Renumbering those
 * refs requires fresh review rather than guessing which repeated key was meant.
 */
export function clashReviewKey(clash: Pick<Clash, 'rule' | 'a' | 'b'>): string;
/**
 * The slot-qualified form, for a host that federates models as stable SLOTS
 * (one discipline model per slot, pinned per coordination round). Each element
 * is keyed by `(slot, key)`, so the same file opened in two slots never shares
 * a decision, and the key carries the rule's semantic revision, so editing a
 * rule's selectors or tolerance under the same rule id never re-attaches a
 * decision taken under the old meaning.
 *
 * Returns `null` when either element's key is repeated within its model
 * (`keyAmbiguous`): such a pair has no identity that survives a re-run, so it
 * gets no carried decision rather than one guessed by per-load ref. It also
 * returns `null` when `slotOf` has no slot for an element's model.
 *
 * Old (unqualified) keys stay readable: see {@link parseClashReviewKey}.
 */
export function clashReviewKey(clash: Pick<Clash, 'rule' | 'a' | 'b'>, options: ClashSlotKeyOptions): string | null;
export function clashReviewKey(clash: Pick<Clash, 'rule' | 'a' | 'b'>, options?: ClashSlotKeyOptions): string | null {
  if (!options) return clashPairId(clash.rule, clashElementIdentity(clash.a), clashElementIdentity(clash.b));
  if (clash.a.keyAmbiguous || clash.b.keyAmbiguous) return null;
  const slotA = options.slotOf(clash.a.model);
  const slotB = options.slotOf(clash.b.model);
  if (slotA === undefined || slotB === undefined) return null;
  return slotPairKey(clash.rule, options.ruleRevision, [slotA, clash.a.key], [slotB, clash.b.key]);
}

/** How to qualify a review key by slot and rule revision. */
export interface ClashSlotKeyOptions {
  /** The stable slot id of a runtime model id; `undefined` when it has none. */
  slotOf: (model: string) => string | undefined;
  /** The rule's semantic revision (`clashRuleRevision`, or a host-pinned value). */
  ruleRevision: string;
}

/** Marker of the slot-qualified key format; never a legacy shape (those are 3-tuples of strings). */
const SLOT_KEY_FORMAT = 'slot/1';

/** Encode a slot-qualified, order-independent pair key. */
export function slotPairKey(rule: string, ruleRevision: string, a: readonly [string, string], b: readonly [string, string]): string {
  const ea = JSON.stringify(a);
  const eb = JSON.stringify(b);
  const [lo, hi] = ea < eb ? [a, b] : [b, a];
  return `@${JSON.stringify([SLOT_KEY_FORMAT, rule, ruleRevision, lo, hi])}`;
}

/** A review key read back into its parts. */
export type ParsedClashReviewKey =
  | { format: 'legacy'; rule: string; a: string; b: string }
  | { format: 'slot'; rule: string; ruleRevision: string; a: { slot: string; key: string }; b: { slot: string; key: string } };

const isString = (value: unknown): value is string => typeof value === 'string';
const isSlotEndpoint = (value: unknown): value is [string, string] =>
  Array.isArray(value) && value.length === 2 && value.every(isString);

/**
 * Read a stored review key, old or new. Legacy keys (`rule lo hi`, or the
 * `@["rule","lo","hi"]` escape) come back as `format: 'legacy'` with their two
 * element identities; slot keys as `format: 'slot'`. `null` for anything else.
 */
export function parseClashReviewKey(key: string): ParsedClashReviewKey | null {
  if (key.startsWith('@')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(key.slice(1));
    } catch {
      return null; // not an encoded key: a malformed stored value, reported as unreadable
    }
    if (!Array.isArray(parsed)) return null;
    if (parsed.length === 3 && parsed.every(isString)) return { format: 'legacy', rule: parsed[0], a: parsed[1], b: parsed[2] };
    if (parsed.length === 5 && parsed[0] === SLOT_KEY_FORMAT && isString(parsed[1]) && isString(parsed[2])
      && isSlotEndpoint(parsed[3]) && isSlotEndpoint(parsed[4])) {
      return { format: 'slot', rule: parsed[1], ruleRevision: parsed[2],
        a: { slot: parsed[3][0], key: parsed[3][1] }, b: { slot: parsed[4][0], key: parsed[4][1] } };
    }
    return null;
  }
  const parts = key.split(' ');
  return parts.length === 3 && parts.every(part => part.length > 0)
    ? { format: 'legacy', rule: parts[0], a: parts[1], b: parts[2] } : null;
}

/** Ranked least-to-most resolved so aggregation can pick the least-resolved. */
const REVIEW_RANK: Record<ClashReviewStatus, number> = { open: 0, resolved: 1, accepted: 2 };

/**
 * Collapse many clash review statuses to one: the LEAST-resolved wins. A BCF
 * topic that bundles several clashes is only "done" once every member is; a
 * single still-open member keeps the whole topic open. An empty set (no members,
 * or none reviewed) is `open`. Unknown labels are treated as unreviewed.
 */
export function aggregateReviewStatus(statuses: Iterable<ClashReviewStatus>): ClashReviewStatus {
  let worst: ClashReviewStatus | null = null;
  for (const value of statuses) {
    const status = Object.hasOwn(REVIEW_RANK, value) ? value : DEFAULT_CLASH_REVIEW_STATUS;
    if (worst === null || REVIEW_RANK[status] < REVIEW_RANK[worst]) worst = status;
  }
  return worst ?? DEFAULT_CLASH_REVIEW_STATUS;
}

/**
 * Map a review status to a BCF 2.1 TopicStatus string.
 *
 * Max-interop mapping (#1468): only the two universally-supported BCF statuses
 * are emitted, so any BCF tool round-trips the archive. `resolved` and
 * `accepted` are both terminal, so both close the topic; the finer distinction
 * is preserved in the topic description's review breakdown, not in TopicStatus.
 */
const REVIEW_STATUS_TO_BCF: Record<ClashReviewStatus, string> = {
  open: 'Open',
  resolved: 'Closed',
  accepted: 'Closed',
};

export function reviewStatusToBcfTopicStatus(status: ClashReviewStatus): string {
  return REVIEW_STATUS_TO_BCF[status];
}
