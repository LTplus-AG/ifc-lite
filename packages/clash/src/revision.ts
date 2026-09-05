/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The safety layer around `compareClashRuns` for a coordinator-facing
 * "compare this run to a saved baseline" feature (#3928).
 *
 * `compareClashRuns` (lifecycle.ts) answers one narrow question — given two
 * `ClashResult`s, which review keys appear in which — and it answers it well
 * (see its own module doc for the model-re-mint handling). It does NOT know
 * anything about the run's *conditions*: whether the same rules were run,
 * whether a rule's selectors matched anything, or whether every model the
 * baseline drew clashes from is still part of the comparison. A caller that
 * feeds it two runs blindly can turn any of those into a false "resolved":
 *
 * - Drop a rule from the matrix between runs (a scope change) and every one of
 *   its previous clashes reads as fixed — nobody re-checked them, the rule
 *   simply didn't run.
 * - A rule whose selector now matches zero elements on one side (renamed
 *   discipline, wrong model loaded) "ran" but compared nothing, so its
 *   previous clashes read as fixed for the same reason.
 * - Unload one of the two models a clash spans and its elements vanish from
 *   `next.clashes` entirely — indistinguishable, at the `ClashResult` level,
 *   from the clash having been genuinely fixed.
 *
 * `compareClashRevisions` wraps `compareClashRuns` and reclassifies any
 * `resolved` clash caught by one of those three conditions into a fourth
 * bucket, `unretested`, so a coordinator is told "we don't know" instead of
 * "fixed". Only `resolved` is at risk — `added` and `persistent` both assert
 * a clash EXISTS in `next`, which the geometry backs directly; `resolved`
 * asserts an ABSENCE, which a run can manufacture for reasons that have
 * nothing to do with the model getting better.
 */

import { ruleHadNoMatch } from './analysis.js';
import { compareClashRuns } from './lifecycle.js';
import type { Clash, ClashResult } from './types.js';

/**
 * One side of a revision comparison: a completed run plus the durable
 * identity of every model it drew elements from.
 *
 * `ClashElementRef.model` (carried on `Clash.a`/`Clash.b`) is the federation's
 * per-LOAD id — `crypto.randomUUID()` in the viewer — so it is deliberately
 * useless for asking "is this model still part of the comparison". `modelNames`
 * is the caller-supplied bridge: a map from that ephemeral id, AS IT APPEARS ON
 * THIS RESULT'S OWN CLASHES, to a durable identity (the model's display name /
 * filename in the viewer). Two different `model` ids that map to the same name
 * are treated as the same model reloaded; a name present in `previous` but
 * absent from `next` is treated as a model the comparison lost entirely.
 *
 * This is a heuristic, not a proof: renaming a model between runs makes it
 * look "missing" (its old name has no counterpart), and two distinctly loaded
 * files that happen to share a display name look like one. Both failure modes
 * point the same way — toward `unretested` rather than a wrongly-confident
 * `resolved` — which is the direction this module exists to be safe in.
 */
export interface ClashRevisionSide {
  result: ClashResult;
  /** Ephemeral `ClashElementRef.model` id → durable display identity. */
  modelNames: Readonly<Record<string, string>>;
}

export interface ClashRevisionReasons {
  /** Rule ids the baseline ran that the current run's `rulesRun` omits entirely. */
  skippedRuleIds: string[];
  /** Rule ids the current run ran but whose coverage matched 0 elements on a
   *  side (`ruleHadNoMatch`) — it ran, but compared nothing. */
  noMatchRuleIds: string[];
  /** Durable model names present in the baseline that have no counterpart
   *  (by name) among the current run's models. */
  missingModelNames: string[];
}

export interface ClashRevisionComparison {
  /** In the current run, not the baseline: new issues. */
  added: Clash[];
  /** In both runs: still open. Carries the current run's `Clash`. */
  persistent: Clash[];
  /** In the baseline, not the current run, AND safe to call fixed: every rule
   *  and model the clash depended on was genuinely re-checked. */
  resolved: Clash[];
  /** In the baseline, not the current run, but NOT safe to call fixed: the
   *  current run could not have found it even if it still existed (a skipped
   *  rule, an empty-match rule, or a model no longer in the comparison). Never
   *  silently folded into `resolved`. */
  unretested: Clash[];
  /** Why each `unretested` clash landed there, for a coordinator's UI banner. */
  reasons: ClashRevisionReasons;
  summary: { added: number; persistent: number; resolved: number; unretested: number };
}

function ruleIdSet(result: ClashResult): Set<string> {
  return new Set(result.rulesRun.map((rule) => rule.id));
}

/** Rule ids in `result.ruleCoverage` whose selectors matched 0 elements on a
 *  side — the rule ran but compared nothing. Absent coverage (a result from
 *  before #… or a hand-built fixture) yields an empty set, never a crash. */
function noMatchRuleIdSet(result: ClashResult): Set<string> {
  const ids = new Set<string>();
  for (const coverage of result.ruleCoverage ?? []) {
    if (ruleHadNoMatch(coverage)) ids.add(coverage.rule);
  }
  return ids;
}

/**
 * Compare a saved baseline run to a current run, safely.
 *
 * Pure and deterministic: depends only on the two inputs. `resolved` only
 * receives a clash whose rule ran (with real matches on both sides) in the
 * current run AND whose two models both still have a same-named counterpart
 * there — everything else that `compareClashRuns` would have called
 * `resolved` moves to `unretested` instead.
 */
export function compareClashRevisions(
  previous: ClashRevisionSide,
  next: ClashRevisionSide,
): ClashRevisionComparison {
  const diff = compareClashRuns(previous.result, next.result);

  const previousRuleIds = ruleIdSet(previous.result);
  const nextRuleIds = ruleIdSet(next.result);
  const skippedRuleIds = [...previousRuleIds].filter((id) => !nextRuleIds.has(id)).sort();
  const skipped = new Set(skippedRuleIds);

  const noMatch = noMatchRuleIdSet(next.result);

  const nextNames = new Set(Object.values(next.modelNames));
  const missingModelNames = [...new Set(Object.values(previous.modelNames))]
    .filter((name) => !nextNames.has(name))
    .sort();
  const missing = new Set(missingModelNames);

  /** A previous-run model id is "lost" if it maps to a name the current run
   *  no longer has ANY model under. An id `previous.modelNames` never named is
   *  not lost — it just means the caller gave us nothing to say about it, and
   *  "unknown" must never manufacture a false confirmation either, so such a
   *  clash is left in `resolved` (see the risk note below). */
  const modelLost = (modelId: string): boolean => {
    const name = previous.modelNames[modelId];
    return name !== undefined && missing.has(name);
  };

  const resolved: Clash[] = [];
  const unretested: Clash[] = [];
  for (const clash of diff.resolved) {
    const unsafe = skipped.has(clash.rule) || noMatch.has(clash.rule) || modelLost(clash.a.model) || modelLost(clash.b.model);
    (unsafe ? unretested : resolved).push(clash);
  }

  return {
    added: diff.added,
    persistent: diff.persistent,
    resolved,
    unretested,
    reasons: {
      skippedRuleIds,
      noMatchRuleIds: [...noMatch].sort(),
      missingModelNames,
    },
    summary: {
      added: diff.added.length,
      persistent: diff.persistent.length,
      resolved: resolved.length,
      unretested: unretested.length,
    },
  };
}
