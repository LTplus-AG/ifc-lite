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

/** A space never occurs inside an IfcGUID / prim path or a rule id, so it is a
 *  safe field separator for the composite key, matching `clashId`'s own scheme. */
const SEP = ' ';

/**
 * A durable, model-independent key for a clash's review state.
 *
 * Unlike `Clash.id`, which embeds the runtime `model` (an ephemeral per-load id
 * in the viewer), this keys purely on the rule id and the two DURABLE element
 * keys (IfcGUID / USD prim path), order-independent. So a review re-attaches to
 * the "same" clash after a page reload, a re-run, or a model revision: the
 * Navisworks "status carries across versions" behaviour the plan calls for.
 */
export function clashReviewKey(clash: Pick<Clash, 'rule' | 'a' | 'b'>): string {
  const ka = clash.a.key;
  const kb = clash.b.key;
  const [lo, hi] = ka <= kb ? [ka, kb] : [kb, ka];
  return `${clash.rule}${SEP}${lo}${SEP}${hi}`;
}

/** Ranked least-to-most resolved so aggregation can pick the least-resolved. */
const REVIEW_RANK: Record<ClashReviewStatus, number> = { open: 0, resolved: 1, accepted: 2 };

/**
 * Collapse many clash review statuses to one: the LEAST-resolved wins. A BCF
 * topic that bundles several clashes is only "done" once every member is; a
 * single still-open member keeps the whole topic open. An empty set (no members,
 * or none reviewed) is `open`.
 */
export function aggregateReviewStatus(statuses: Iterable<ClashReviewStatus>): ClashReviewStatus {
  let worst: ClashReviewStatus | null = null;
  for (const s of statuses) {
    if (worst === null || REVIEW_RANK[s] < REVIEW_RANK[worst]) worst = s;
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
