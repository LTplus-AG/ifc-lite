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
 *
 * The review key is NOT unique within a run, and the matching below is built
 * around that. Dropping `model` is what makes the key durable, but the engine
 * treats `(model, key)` as element identity — `orchestrator.ts` skips a pair
 * only when `elA.key === elB.key && elA.model === elB.model` — and
 * `adapters/ifcx.ts` keys on the bare USD prim path while `adapters/step.ts`
 * keys on the bare IfcGUID (only its `syntheticKey` fallback folds in the
 * model id). A federated run gathers every loaded model, so one run can
 * legitimately hold several DISTINCT clashes under one review key: `/Duct` in
 * layer-a and `/Duct` in layer-b each hitting the same wall. Matching by key
 * membership alone would collapse those, silently swallowing a resolved clash
 * and reporting a genuinely new one as pre-existing, so occurrences are
 * grouped per key and paired (see `pairGroup`) instead.
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
 * "Present in" counts occurrences, not just review keys: two clashes sharing a
 * review key in one run need a counterpart each to both be `persistent`.
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

/** The three output buckets, filled in as groups are paired up. */
interface Buckets {
  added: Clash[];
  persistent: Clash[];
  resolved: Clash[];
}

/**
 * Group a run's clashes by their durable review key (`clashReviewKey`, not
 * `clash.id` — see the module docstring), keeping EVERY occurrence rather than
 * the last one. The key is deliberately not unique within a run (module
 * docstring), so the group length is the multiplicity that `pairGroup` needs
 * in order to tell "the same clash, seen again" from "a second, different
 * clash that happens to share a review key".
 */
function groupByReviewKey(run: ClashResult): Map<string, Clash[]> {
  const groups = new Map<string, Clash[]>();
  for (const clash of run.clashes) {
    const key = clashReviewKey(clash);
    const group = groups.get(key);
    if (group) group.push(clash);
    else groups.set(key, [clash]);
  }
  return groups;
}

/** Every `model` id that appears on any clash in a run. `toRef`
 *  (`engine-ts/orchestrator.ts`) carries `model` onto both of a `Clash`'s
 *  element refs, so this is readable from a `ClashResult` alone. A model that
 *  produced no clash at all in the run is invisible here — see `pairGroup`. */
function modelsInRun(run: ClashResult): Set<string> {
  const models = new Set<string>();
  for (const clash of run.clashes) {
    models.add(clash.a.model);
    models.add(clash.b.model);
  }
  return models;
}

/** The `model` ids each run clashed in, used to tell a re-load from a swap. */
interface RunModels {
  previous: Set<string>;
  next: Set<string>;
}

/** True when both of a clash's elements sit in models the other run also
 *  clashed in, i.e. that clash's `clash.id` was still mintable there. */
function bothModelsIn(clash: Clash, models: Set<string>): boolean {
  return models.has(clash.a.model) && models.has(clash.b.model);
}

/** Split into [matching, rest], preserving run order in both. */
function partition(clashes: Clash[], keep: (clash: Clash) => boolean): [Clash[], Clash[]] {
  const yes: Clash[] = [];
  const no: Clash[] = [];
  for (const clash of clashes) (keep(clash) ? yes : no).push(clash);
  return [yes, no];
}

/**
 * Pair one review key's previous-run occurrences against its next-run ones.
 *
 * Equal `clash.id`s are paired first. `clashId()` folds both elements' `model`
 * into the id, so an id match is the same clash between the same two loaded
 * models — which covers the whole of the "federated session that did not
 * reload" case, pairing every surviving clash with ITSELF.
 *
 * A leftover is the same real-world clash seen again only if `model` was
 * re-minted between the runs, and the data says whether it was: a previous-run
 * leftover whose two models BOTH still clash somewhere in the next run was not
 * re-minted, so had that clash survived it would have produced the same id and
 * paired above — it is genuinely `resolved`. The mirror of that is genuinely
 * `added`. Only leftovers whose models the other run no longer shows — the
 * re-load this whole module exists to diff — are paired with each other, in
 * run order, and the surplus on either side is `added` / `resolved`. Without
 * that model test, two runs of one federated session in which the wall stops
 * hitting `/Duct` in layer-a and starts hitting `/Duct` in layer-b would pair
 * on count alone: the fixed clash would vanish from `resolved` and the new one
 * would be reported as pre-existing.
 *
 * The model ids are read off the two runs' clashes, so a model that produced
 * no clash at all in a run is invisible to the test and its clashes count as
 * re-minted. That errs towards pairing, i.e. towards `persistent`: the
 * churn-free reading, not a claim that something was fixed.
 *
 * `persistent` always receives the NEXT run's Clash (current geometry).
 */
function pairGroup(previous: Clash[], next: Clash[], models: RunModels, out: Buckets): void {
  const prevIndicesById = new Map<string, number[]>();
  previous.forEach((clash, i) => {
    const slot = prevIndicesById.get(clash.id);
    if (slot) slot.push(i);
    else prevIndicesById.set(clash.id, [i]);
  });

  const matchedPrev = new Array<boolean>(previous.length).fill(false);
  const unmatchedNext: Clash[] = [];
  for (const clash of next) {
    const index = prevIndicesById.get(clash.id)?.shift();
    if (index === undefined) {
      unmatchedNext.push(clash);
    } else {
      matchedPrev[index] = true;
      out.persistent.push(clash);
    }
  }

  const unmatchedPrev = previous.filter((_, i) => !matchedPrev[i]);
  const [reloadedPrev, stillLivePrev] = partition(
    unmatchedPrev,
    (clash) => !bothModelsIn(clash, models.next),
  );
  const [reloadedNext, stillLiveNext] = partition(
    unmatchedNext,
    (clash) => !bothModelsIn(clash, models.previous),
  );
  out.resolved.push(...stillLivePrev);
  out.added.push(...stillLiveNext);

  const paired = Math.min(reloadedPrev.length, reloadedNext.length);
  out.persistent.push(...reloadedNext.slice(0, paired));
  out.added.push(...reloadedNext.slice(paired));
  out.resolved.push(...reloadedPrev.slice(paired));
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
  const prevGroups = groupByReviewKey(previous);
  const nextGroups = groupByReviewKey(next);

  const models: RunModels = { previous: modelsInRun(previous), next: modelsInRun(next) };

  const buckets: Buckets = { added: [], persistent: [], resolved: [] };

  for (const [key, nextGroup] of nextGroups) {
    pairGroup(prevGroups.get(key) ?? [], nextGroup, models, buckets);
  }
  for (const [key, prevGroup] of prevGroups) {
    if (!nextGroups.has(key)) buckets.resolved.push(...prevGroup);
  }

  const { added, persistent, resolved } = buckets;
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
