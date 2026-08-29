/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash lifecycle across model revisions (Phase 5).
 *
 * Compares two clash runs and partitions their clashes into added / resolved /
 * persistent buckets. Matching is by `clashReviewKey` (review.ts) — the rule id
 * plus the two elements' durable keys (IfcGUID / USD prim path), order-
 * independent — NOT by the raw `clash.id`. `clash.id` (`engine-ts/orchestrator.
 * ts`'s `clashId()`) also folds in `ClashElement.model`, which review.ts
 * documents as "an ephemeral per-load id in the viewer": two loads of the
 * identical geometry — exactly the "revision" scenario this module exists to
 * diff — get two different `model` values and therefore two different
 * `clash.id`s for the same real-world clash. Matching on the review key keeps
 * the diff stable across loads: a clash that survives a revision is reported
 * as `persistent` rather than as a resolve-plus-add churn.
 */

import { clashReviewKey } from './review.js';
import type { Clash, ClashResult } from './types.js';

/**
 * The result of comparing a previous clash run to a later ("next") one.
 *
 * - `added`      clashes present in `next` but not in `previous` (new issues)
 * - `persistent` clashes present in both runs (still open; the `next` Clash)
 * - `resolved`   clashes present in `previous` but not in `next` (fixed/removed)
 *
 * Each array is sorted by `clash.id` for deterministic, diff-friendly output.
 */
export interface ClashRevisionDiff {
  added: Clash[];
  persistent: Clash[];
  resolved: Clash[];
  summary: { added: number; persistent: number; resolved: number };
}

/** Stable string compare for ids (ASCII/Unicode code-point order). */
function byId(a: Clash, b: Clash): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Index a run's clashes by their durable review key (`clashReviewKey`, not
 * `clash.id` — see the module docstring) for O(1) membership checks. The
 * engine dedups clash ids within a run, and the review key is a function of
 * the same rule + durable element keys, so it is unique here too. If a caller
 * passed a hand-built run with a repeated key, the map keeps the last
 * occurrence for membership tests, while the added/persistent/resolved
 * buckets below iterate the raw clash arrays — so a duplicate key would
 * appear once per occurrence in its bucket and in the counts.
 */
function indexByReviewKey(run: ClashResult): Map<string, Clash> {
  const byKey = new Map<string, Clash>();
  for (const clash of run.clashes) {
    byKey.set(clashReviewKey(clash), clash);
  }
  return byKey;
}

/**
 * Compare two clash runs and partition their clashes by lifecycle state.
 *
 * Pure and deterministic: the output depends only on the two inputs, never on
 * the clock or any randomness. The `persistent` bucket returns the `next` run's
 * Clash (the current geometry/point/distance for a still-open issue), so a
 * caller can render the up-to-date state. Each array is sorted by id.
 */
export function compareClashRuns(previous: ClashResult, next: ClashResult): ClashRevisionDiff {
  const prevByKey = indexByReviewKey(previous);
  const nextByKey = indexByReviewKey(next);

  const added: Clash[] = [];
  const persistent: Clash[] = [];
  const resolved: Clash[] = [];

  for (const clash of next.clashes) {
    if (prevByKey.has(clashReviewKey(clash))) {
      // Present in both runs: still open. Report the next run's Clash so the
      // caller sees current geometry, not the stale previous-revision copy.
      persistent.push(clash);
    } else {
      added.push(clash);
    }
  }

  for (const clash of previous.clashes) {
    if (!nextByKey.has(clashReviewKey(clash))) {
      resolved.push(clash);
    }
  }

  added.sort(byId);
  persistent.sort(byId);
  resolved.sort(byId);

  return {
    added,
    persistent,
    resolved,
    summary: {
      added: added.length,
      persistent: persistent.length,
      resolved: resolved.length,
    },
  };
}
