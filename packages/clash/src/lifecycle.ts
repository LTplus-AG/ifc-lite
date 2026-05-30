/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash lifecycle across model revisions (Phase 5).
 *
 * Compares two clash runs and partitions their clashes into added / resolved /
 * persistent buckets. Matching is by the stable `clash.id`, which is durable
 * across revisions because it derives from the elements' durable keys
 * (IfcGUID / USD prim path) plus the rule id — not from runtime refs that
 * change between loads. This makes the diff stable: a clash that survives a
 * revision keeps its id and is reported as `persistent` rather than as a
 * resolve-plus-add churn.
 */

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
 * Index a run's clashes by their stable id for O(1) membership checks. The
 * engine dedups clash ids within a run, so ids are unique here. If a caller
 * passed a hand-built run with a repeated id, the map keeps the last occurrence
 * for membership tests, while the added/persistent/resolved buckets below
 * iterate the raw clash arrays — so a duplicate id would appear once per
 * occurrence in its bucket and in the counts.
 */
function indexById(run: ClashResult): Map<string, Clash> {
  const byKey = new Map<string, Clash>();
  for (const clash of run.clashes) {
    byKey.set(clash.id, clash);
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
  const prevById = indexById(previous);
  const nextById = indexById(next);

  const added: Clash[] = [];
  const persistent: Clash[] = [];
  const resolved: Clash[] = [];

  for (const clash of next.clashes) {
    if (prevById.has(clash.id)) {
      // Present in both runs: still open. Report the next run's Clash so the
      // caller sees current geometry, not the stale previous-revision copy.
      persistent.push(clash);
    } else {
      added.push(clash);
    }
  }

  for (const clash of previous.clashes) {
    if (!nextById.has(clash.id)) {
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
