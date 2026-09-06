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
 *
 * The condition-level checks above reason at RULE/MODEL granularity, but
 * clash identity is per-ELEMENT. A rule can keep matching non-zero elements
 * on both sides while silently dropping the ONE element a specific baseline
 * clash depended on (a narrowed selector, or a re-scoped `membersA`/`membersB`
 * filter) — invisible to a count-only coverage check. And a durable key can
 * vanish entirely between exports (a re-minted GlobalId) — `compareClashRuns`
 * correctly can't match old to new, so it reports a `resolved` half and an
 * `added` half for what is really one still-live clash. Both cases are the
 * SAME question in disguise: "was this clash's specific element actually
 * re-examined in `next`, under this same rule?" — so `elementsReexamined`
 * below answers that directly from `ruleCoverage[].matchedKeysA/B` (the
 * durable keys the current run's rule actually matched), rather than from the
 * coarser rule/model conditions. A rule with no tracked keys (an older result,
 * or a hand-built fixture) cannot be verified and is treated as unsafe — the
 * fail-safe direction this whole module exists to take.
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

/** Per rule id, the durable keys the CURRENT run's rule matched on each side,
 *  kept SEPARATE (never unioned) — see `elementsReexamined`, which is the
 *  reason this exists in this shape. `sideB === null` marks a self-clash rule
 *  (no `b` selector/`membersB`): there is only one group, and `a` and `b` on
 *  a `Clash` from that rule are two members of that SAME group, not two
 *  distinct roles. */
interface RuleKeys {
  sideA: Set<string>;
  sideB: Set<string> | null;
}

/**
 * Per rule id, the sets of durable keys the CURRENT run's rule actually
 * matched, one set per side — element-level membership, not a count. A rule
 * id is deliberately absent from the returned map (rather than mapped to an
 * empty set) whenever it cannot be verified: the rule didn't run this time
 * (dropped from `ruleCoverage` entirely), or the coverage entry predates
 * key-tracking (`matchedKeysA` undefined — an older result or a hand-built
 * fixture). Callers must read "absent" as "unknown", never as "matched
 * nothing" — see `elementsReexamined`.
 */
function ruleMatchedKeys(result: ClashResult): Map<string, RuleKeys> {
  const map = new Map<string, RuleKeys>();
  for (const coverage of result.ruleCoverage ?? []) {
    if (coverage.matchedKeysA === undefined) continue; // untracked: leave unmapped, not empty
    const sideA = new Set(coverage.matchedKeysA);
    const sideB = coverage.matchedKeysB === null ? null : new Set(coverage.matchedKeysB);
    map.set(coverage.rule, { sideA, sideB });
  }
  return map;
}

/**
 * Whether a clash's two elements are confirmed, by durable key, to still be
 * matched by this SAME rule in the current run, in the roles the ORCHESTRATOR
 * (`engine-ts/orchestrator.ts`) actually assigns them.
 *
 * Role-qualified, not order-independent, for a two-sided rule: `groupA`/
 * `groupB` there are resolved once from `rule.a`/`membersA` and `rule.b`/
 * `membersB`, and the broad phase only ever pairs `groupA[i] x groupB[j]` — a
 * `NarrowRecord`'s `a` is always a global index drawn from `groupA`, `b`
 * always from `groupB` (`broad.ts`). So `clash.a` is always "the element that
 * matched side A" and `clash.b` always "the element that matched side B" for
 * that rule, even when the two member sets overlap (the same physical element
 * can appear as `a` in one clash instance and `b` in another, but never both
 * within ONE clash record). Requiring the opposite assignment to also count
 * would let a wall that moved from role A to role B alone — with its actual
 * former partner never re-paired against it — read as "still matched",
 * exactly the false `resolved` this module exists to prevent (the
 * `matchedKeysA`/`matchedKeysB` union this replaces made precisely that
 * mistake).
 *
 * `clashReviewKey` (review.ts) is order-independent, but that is a statement
 * about MATCHING two `Clash` records across runs as "the same real-world
 * clash" (so a and b can be seen in either order there without losing the
 * pairing) — it says nothing about whether a role SWAP within one clash
 * instance is safe to treat as "re-examined". It is not, here: the roles are
 * fixed by the rule's own selector/membership resolution, not interchangeable.
 *
 * For a self-clash rule (`sideB === null`, no `b` side at all: `a` and `b` on
 * such a clash are just two members of the one group, symmetric by
 * construction), both elements are checked against the single set.
 */
function elementsReexamined(clash: Clash, matchedKeys: Map<string, RuleKeys>): boolean {
  const keys = matchedKeys.get(clash.rule);
  if (!keys) return false;
  if (keys.sideB === null) return keys.sideA.has(clash.a.key) && keys.sideA.has(clash.b.key);
  return keys.sideA.has(clash.a.key) && keys.sideB.has(clash.b.key);
}

/** How many distinct model ids share each display name — a plain `Set` of
 *  names cannot tell "this name still has a model" from "this name has a
 *  DIFFERENT model than before", which is exactly what two same-named models
 *  (a common federation setup: several disciplines all exported as
 *  `mep.ifc`-style filenames) needs. */
function nameCounts(modelNames: Readonly<Record<string, string>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of Object.values(modelNames)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
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

  const noMatch = noMatchRuleIdSet(next.result);
  const matchedKeys = ruleMatchedKeys(next.result);

  // A name's count DROPPING between runs means at least one model under it is
  // genuinely gone, and — because two models sharing a name are otherwise
  // indistinguishable by anything this module is given — WHICH one cannot be
  // known. Every previous model under that name is therefore treated as lost,
  // which over-flags the survivor(s) too (a false `unretested`, the safe
  // direction) rather than risk crediting a genuinely-gone model's clash as
  // `resolved` (a false confirmation, the direction this module exists to
  // prevent). A name whose count held steady or grew is NOT flagged: every
  // previous model under it still has as many same-named counterparts as
  // before, which is the best this heuristic can say without a firmer signal
  // (content or size — see #3945's federation matcher for that fuller sense
  // of "identity", not available here from a bare id→name map).
  const previousCounts = nameCounts(previous.modelNames);
  const nextCounts = nameCounts(next.modelNames);
  const missingModelNames = [...previousCounts.keys()]
    .filter((name) => (nextCounts.get(name) ?? 0) < (previousCounts.get(name) ?? 0))
    .sort();
  const missing = new Set(missingModelNames);

  /** A previous-run model id is "lost" if it maps to a name whose count
   *  dropped in the current run. An id `previous.modelNames` never named is
   *  not lost — it just means the caller gave us nothing to say about it, and
   *  "unknown" must never manufacture a false confirmation either, so such a
   *  clash is left to the element-level check below. */
  const modelLost = (modelId: string): boolean => {
    const name = previous.modelNames[modelId];
    return name !== undefined && missing.has(name);
  };

  const resolved: Clash[] = [];
  const unretested: Clash[] = [];
  for (const clash of diff.resolved) {
    const unsafe =
      skippedRuleIds.includes(clash.rule) ||
      noMatch.has(clash.rule) ||
      modelLost(clash.a.model) ||
      modelLost(clash.b.model) ||
      !elementsReexamined(clash, matchedKeys);
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
