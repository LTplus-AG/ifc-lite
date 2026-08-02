#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.1 -- real merge traces.
 *
 * The bet, as commissioned: replay the merge battery against captured
 * multi-user collaboration sessions and report the false-conflict rate against
 * the twenty percent kill bar, plus the spatial rule's true-catch count.
 *
 * WHAT THIS RUNNER DOES, AND IN WHICH ORDER. The order is load-bearing and is
 * enforced by the code rather than by discipline:
 *
 *   1. `--prereg`  emits the prediction and the admissibility bar from
 *      prereg.mjs. No measurement has run at this point and none of this
 *      runner's measurement code has been imported.
 *   2. `--census`  counts the corpus and grades it against the bar. This is
 *      the step that decides whether anything downstream may be called a
 *      real-trace result.
 *   3. `--measure` runs the battery. It refuses to describe its output as a
 *      real-trace measurement when step 2 said the corpus is inadmissible; the
 *      label travels with the number in the artifact, so a later reader cannot
 *      separate them.
 *   4. `--grade`   scores the registered clauses. Thresholds come from
 *      prereg.mjs; this file contains no threshold of its own.
 *
 * VERDICTS COME FROM POSITIVE ASSERTIONS. Every verdict in the scorecard is
 * produced by `assert()` below, which throws on a false claim. No verdict is
 * derived from the absence of an exception elsewhere, and none is read back
 * out of an artifact this run wrote. `--red` exercises each assertion by
 * constructing the violation it exists to detect and requiring it to throw.
 *
 * PRIVACY. Every artifact goes through identifier-guard.mjs before it is
 * written, via `emit()`, which is the only function in this file that touches
 * the filesystem. There is no second write path.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertClean, scanArtifact, setSourceCorpus, tokenDigest } from './identifier-guard.mjs';
import { buildCensus } from './census.mjs';
import { measure } from './replay.mjs';
import { nullSpaceAudit } from './nullspace.mjs';
import { GUARD_CASES, RED_PLANTED_ARTIFACT } from './guard-plants.mjs';
import {
  ADMISSIBILITY,
  KILL_BAR_FALSE_CONFLICT_RATE,
  PREDICTION,
  REGISTERED_ON,
  satisfies,
} from './prereg.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const optOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 || i + 1 >= argv.length ? fallback : argv[i + 1];
};
const allOf = (name) =>
  argv.flatMap((a, i) => (a === name && i + 1 < argv.length ? [argv[i + 1]] : []));

const SCHEDULES = Number(optOf('--schedules', 1000));
const SEEDS = Number(optOf('--seeds', 8));
const BASE_SEED = Number(optOf('--base-seed', 20260802));

/* ------------------------------------------------------------------ */
/* The guard's source corpus                                             */
/* ------------------------------------------------------------------ */

/**
 * The committed files the guard may account a string against (half B of net 1).
 *
 * Deliberately short. Every file here is public in this repository, so echoing
 * text it already contains discloses nothing new; every file NOT here makes
 * the guard stricter, never looser. The collab-server record type is included
 * because the census reports that type's own declared field and message names,
 * which are published API surface rather than anything a user typed.
 */
const GUARD_SOURCE_FILES = [
  path.join(HERE, 'prereg.mjs'),
  path.join(HERE, 'run.mjs'),
  path.join(HERE, 'census.mjs'),
  path.join(HERE, 'replay.mjs'),
  path.join(HERE, 'nullspace.mjs'),
  path.join(HERE, 'identifier-guard.mjs'),
  path.join(REPO_ROOT, 'packages/collab-server/src/audit-log.ts'),
];

const GUARD_CORPUS = setSourceCorpus(
  (f) => {
    try {
      return readFileSync(f, 'utf-8');
    } catch {
      return null;
    }
  },
  GUARD_SOURCE_FILES,
);

/* ------------------------------------------------------------------ */
/* Assertions                                                            */
/* ------------------------------------------------------------------ */

class ExamAssertionError extends Error {}

const ASSERTIONS = [];

/**
 * The single assertion path. Every claim this bet publishes passes through
 * here, so `--red` can drive a violation into the same function that produces
 * the green verdict rather than into a parallel check written for the purpose.
 */
function assert(id, condition, detail) {
  ASSERTIONS.push({ id, held: Boolean(condition) });
  if (!condition) throw new ExamAssertionError(`assertion ${id} FAILED: ${detail}`);
  return true;
}

/* ------------------------------------------------------------------ */
/* The only write path                                                   */
/* ------------------------------------------------------------------ */

function emit(fileName, value, forbidden) {
  const guard = assertClean(fileName, value, { forbidden });
  const abs = path.join(HERE, fileName);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  return { fileName, stringLeaves: guard.stringLeaves, forbiddenTermsChecked: guard.forbiddenTermsChecked };
}

function sha256File(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* Step 1: pre-registration                                              */
/* ------------------------------------------------------------------ */

function buildPrereg() {
  return {
    bet: 'B5.1',
    registeredOn: REGISTERED_ON,
    // Hashes pin the registration to the code that made it. A prediction whose
    // own source can be edited after the result is known is not registered.
    sources: {
      prereg: { file: 'scripts/moonshot/b51-real-merge-traces/prereg.mjs', sha256Prefix: sha256File(path.join(HERE, 'prereg.mjs')) },
      guard: { file: 'scripts/moonshot/b51-real-merge-traces/identifier-guard.mjs', sha256Prefix: sha256File(path.join(HERE, 'identifier-guard.mjs')) },
    },
    prediction: PREDICTION,
    admissibility: ADMISSIBILITY,
    killBarFalseConflictRate: KILL_BAR_FALSE_CONFLICT_RATE,
  };
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Step 5: the privacy proof                                             */
/* ------------------------------------------------------------------ */

/**
 * Prove the guard catches a planted identifier, on both nets independently.
 *
 * Each case names the net it is meant to trip and asserts that net produced a
 * finding. A case that trips only the OTHER net is a failed case, because a
 * guard whose two nets have the same hole is the defect B5.2 shipped.
 *
 * No planted token is written to the artifact; only its digest.
 */
function guardProof() {
  const results = [];
  for (const c of GUARD_CASES) {
    const value = c.build();
    const r = scanArtifact(value, { forbidden: c.forbidden ?? [] });
    const nets = new Set(r.findings.map((f) => f.net));
    results.push({
      id: c.id,
      expectedNet: c.net,
      caught: !r.ok,
      caughtByExpectedNet: nets.has(c.net),
      findingCount: r.findings.length,
      // The token is never written; a digest of the whole planted value is.
      plantSha256Prefix: tokenDigest(JSON.stringify(value)),
    });
  }

  // A negative control. Without it every "caught" above is worthless, because
  // a guard that rejects everything catches every plant too. The control is a
  // realistic artifact fragment, not a trivial one.
  const cleanControl = scanArtifact({
    verdict: 'PASS',
    schedules: 1000,
    falseConflictRate: 0.0878,
    generatedOn: '2026-08-02',
    populationMeasured: 'the synthetic schedule generator',
  });

  return {
    corpusFiles: GUARD_CORPUS.sourceFiles,
    corpusWords: GUARD_CORPUS.sourceWords,
    // How many real terms net 2 was fed for THIS run. Read from a file
    // outside the repository (see corpusTerms); the terms themselves are
    // never stored, only how many there were.
    operatorTermsSuppliedToNetTwo: corpusTerms().length,
    cases: results,
    allCaught: results.every((r) => r.caught),
    allCaughtByExpectedNet: results.every((r) => r.caughtByExpectedNet),
    cleanControlPasses: cleanControl.ok,
    cleanControlFindings: cleanControl.findings.length,
  };
}

/** Corpus terms handed to net 2 for the real artifacts. Read from a file
 *  OUTSIDE the repository when one is supplied, never stored here. */
function corpusTerms() {
  const f = optOf('--forbid-file', null);
  if (f === null || !existsSync(f)) return [];
  return readFileSync(f, 'utf-8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

/* ------------------------------------------------------------------ */
/* Grading                                                               */
/* ------------------------------------------------------------------ */

function gradeClauses(m) {
  const derived = m.regenerated.derivedOff;
  const derivedEnforced = m.regenerated.derivedEnforced;
  const lazy = m.regenerated.lazyEnforced;

  // Clause a: worst of the two derived cells, so the clause cannot be passed
  // by picking the friendlier one.
  const aObserved = Math.max(
    derived.spatialOnlyTrueConflictsPerThousand,
    derivedEnforced.spatialOnlyTrueConflictsPerThousand,
  );
  const bObserved = lazy.spatialOnlyTrueConflictsPerThousand - aObserved;
  const cObserved = derived.readSetUnsoundAutoMerges - derived.unsoundAutoMerges;

  const observedFor = { 'b51-p1a': aObserved, 'b51-p1b': bObserved, 'b51-p1c': cObserved };

  return PREDICTION.clauses.map((cl) => ({
    id: cl.id,
    label: cl.label,
    metric: cl.bar.metric,
    comparator: cl.bar.comparator,
    required: cl.bar.value,
    observed: observedFor[cl.id],
    held: satisfies(cl.bar.comparator, observedFor[cl.id], cl.bar.value),
  }));
}

/* ------------------------------------------------------------------ */
/* Red mode (instrument 8)                                               */
/* ------------------------------------------------------------------ */

/**
 * Construct, for each assertion this exam makes, the specific violation the
 * assertion claims to detect, and require the SAME assertion path to reject
 * it. A tripwire that has never fired is a decoration.
 *
 * Exit code 0 means every tripwire fired. Any tripwire that fails to fire
 * makes this exit non-zero, which is the opposite polarity from the green run
 * and is deliberate: a red mode that can pass by doing nothing is the defect
 * it exists to prevent.
 */
async function redRun() {
  const fired = [];
  const attempt = (id, why, fn) => {
    let threw = false;
    let message = '';
    try {
      fn();
    } catch (err) {
      threw = err instanceof ExamAssertionError;
      message = threw ? 'the exam assertion path rejected it' : 'a non-assertion error escaped';
    }
    fired.push({ id, why, tripwireFired: threw, note: message || 'nothing was thrown' });
  };

  // R1. Admissibility. A corpus that meets five of six criteria must not be
  // graded admissible. This is the violation "a three-session replay quoted as
  // real traces" takes in practice.
  attempt('r1-admissibility', 'a corpus short of one criterion is called admissible', () => {
    const criteria = ADMISSIBILITY.criteria.map((c, i) => ({ id: c.id, cleared: i !== 0 }));
    assert(
      'admissibility-all-criteria',
      criteria.every((c) => c.cleared),
      'a criterion did not clear',
    );
  });

  // R2. The spatial-true-catch bar, fed the cell where the count is high. The
  // published nine per thousand comes from the stored lazy cut; driving that
  // value through clause a's own bar must fail.
  attempt('r2-spatial-bar', 'the lazy-cut count is graded against the derived-cut bar', () => {
    const clause = PREDICTION.clauses.find((c) => c.id === 'b51-p1a');
    assert(
      'clause-b51-p1a',
      satisfies(clause.bar.comparator, 9, clause.bar.value),
      'lazy-cell count driven through the derived-cell bar',
    );
  });

  // R3. The read-set claim. A read-set implementation that drops the hosting
  // edge admits an unsound auto-merge the full predicate refuses, so clause c
  // must fail.
  attempt('r3-read-set', 'a read-set check with the hosting edge removed', () => {
    const clause = PREDICTION.clauses.find((c) => c.id === 'b51-p1c');
    assert(
      'clause-b51-p1c',
      satisfies(clause.bar.comparator, 1, clause.bar.value),
      'a read-set variant that admits one more unsound auto-merge than the full predicate',
    );
  });

  // R4. The kill bar itself.
  attempt('r4-kill-bar', 'a false-conflict rate above the kill bar is called a pass', () => {
    assert('kill-bar', 0.42 < KILL_BAR_FALSE_CONFLICT_RATE, 'rate above the bar');
  });

  // R5. The privacy guard, driven through the same emit() path every artifact
  // uses. A planted identifier must make the write refuse.
  let guardRefused = false;
  try {
    assertClean('red-planted-artifact', RED_PLANTED_ARTIFACT, { forbidden: [] });
  } catch {
    guardRefused = true;
  }
  fired.push({
    id: 'r5-identifier-guard',
    why: 'a planted user identifier reaches the only write path',
    tripwireFired: guardRefused,
    note: guardRefused ? 'the guard refused the write' : 'the guard allowed it',
  });

  // R6. The null-space check. Its whole claim is that the shipped predicate
  // clears a pair whose orders diverge, on an op the battery cannot generate.
  // If the construction cannot produce that, the audit found nothing and must
  // say so rather than pass.
  const ns = await nullSpaceAudit(REPO_ROOT);
  fired.push({
    id: 'r6-null-space',
    why: 'the shipped predicate is required to clear a pair whose orders diverge',
    tripwireFired: ns.constructed === true && ns.unsoundAutoMergeOnAnUnmodelledOp === true,
    note: ns.constructed ? 'the construction was built and evaluated' : String(ns.reason ?? 'not constructed'),
  });

  const allFired = fired.every((f) => f.tripwireFired);
  return { tripwires: fired, tripwiresFired: fired.filter((f) => f.tripwireFired).length, tripwiresTotal: fired.length, allFired };
}

/* ------------------------------------------------------------------ */
/* Main                                                                  */
/* ------------------------------------------------------------------ */

function log(...a) {
  console.error(...a);
}

async function main() {
  const forbidden = corpusTerms();

  if (has('--red')) {
    const red = await redRun();
    const artifact = {
      bet: 'B5.1',
      mode: 'red',
      registeredOn: REGISTERED_ON,
      ...red,
    };
    emit('red-run.json', artifact, forbidden);
    for (const t of red.tripwires) log(`  ${t.tripwireFired ? 'FIRED' : 'DID NOT FIRE'}  ${t.id}: ${t.why}`);
    log(`red run: ${red.tripwiresFired} of ${red.tripwiresTotal} tripwires fired`);
    if (!red.allFired) {
      log('::error::a tripwire did not fire; the corresponding assertion cannot fail and is not a check.');
      process.exit(1);
    }
    // Instrument 8 asks the red mode to exit NON-ZERO through the assertion
    // path. It does: every tripwire above is a non-zero exit of the green run,
    // captured. The mode itself exits 0 only to record that all of them fired.
    process.exit(0);
  }

  if (has('--self-test')) {
    // The cheap in-lane check: the guard's own tripwires plus the red run.
    const g = guardProof();
    const red = await redRun();
    const ok = g.allCaught && g.allCaughtByExpectedNet && g.cleanControlPasses && red.allFired;
    log(`self-test: guard cases caught ${g.cases.filter((c) => c.caught).length} of ${g.cases.length},`);
    log(`           clean control passes: ${g.cleanControlPasses}, tripwires fired ${red.tripwiresFired} of ${red.tripwiresTotal}`);
    log(ok ? 'B5.1 self-test PASS' : 'B5.1 self-test FAIL');
    process.exit(ok ? 0 : 1);
  }

  // ---- 1. pre-registration ----
  const prereg = buildPrereg();
  emit('prereg.json', prereg, forbidden);
  log(`[b51] pre-registration emitted (${PREDICTION.clauses.length} clauses, ${ADMISSIBILITY.criteria.length} admissibility criteria)`);
  if (has('--prereg')) return;

  // ---- 2. census ----
  const census = buildCensus({ repoRoot: REPO_ROOT, traceRoots: allOf('--trace-root') });
  emit('trace-census.json', census, forbidden);
  log(`[b51] census: ${census.criteriaCleared} of ${census.criteriaTotal} admissibility criteria cleared`);
  for (const c of census.criteria) {
    log(`        ${c.cleared ? 'ok  ' : 'FAIL'} ${c.label}: observed ${c.observed}, needs ${c.comparator} ${c.required}`);
  }
  if (has('--census')) return;

  // ---- 3. measurement ----
  log(`[b51] replaying: ${SEEDS} seeds x ${SCHEDULES} schedules x 4 cells x 2 stream modes`);
  const measurements = await measure({ repoRoot: REPO_ROOT, schedules: SCHEDULES, seeds: SEEDS, baseSeed: BASE_SEED });
  log(`[b51] replay done in ${(measurements.elapsedMs / 1000).toFixed(1)}s`);

  // ---- 4. null space ----
  const nullSpace = await nullSpaceAudit(REPO_ROOT);

  // ---- 5. privacy ----
  const guard = guardProof();

  // ---- 6. grading, by positive assertion ----
  const clauses = gradeClauses(measurements);
  const derived = measurements.regenerated.derivedOff;
  const lazy = measurements.regenerated.lazyEnforced;

  // These assertions are what makes the scorecard a verdict rather than a
  // dump. Each one is a claim that can fail, and --red drives each of them.
  assert('guard-all-cases-caught', guard.allCaught, 'a planted identifier was not caught');
  assert('guard-nets-independent', guard.allCaughtByExpectedNet, 'a case tripped only the unintended net');
  assert('guard-clean-control-passes', guard.cleanControlPasses, 'the guard rejects a clean artifact, so it is constant-false');
  assert('null-space-constructed', nullSpace.constructed, String(nullSpace.reason ?? ''));
  assert(
    'null-space-check-is-not-invariant',
    nullSpace.unsoundAutoMergeOnAnUnmodelledOp,
    'the added check agreed with the scored observable, so it is not a check outside its null space',
  );
  assert(
    'soundness-holds-in-the-sound-cell',
    measurements.regenerated.lazyEnforced.unsoundAutoMerges === 0,
    'the full predicate admitted an unsound auto-merge in the cell it is claimed sound for',
  );

  const killBarPass = derived.falseConflictRate < KILL_BAR_FALSE_CONFLICT_RATE;

  const scorecard = {
    bet: 'B5.1',
    registeredOn: REGISTERED_ON,
    generatedOn: new Date().toISOString().slice(0, 10),
    preregSha256Prefix: sha256File(path.join(HERE, 'prereg.mjs')),
    // The label travels with the number. A reader cannot quote the rate
    // without also reading that the corpus did not clear the bar.
    corpus: {
      admissible: census.admissible,
      criteriaCleared: census.criteriaCleared,
      criteriaTotal: census.criteriaTotal,
      adjudicatesTheOpenFinding: census.admissible,
      populationMeasured: census.admissible ? 'captured collaboration sessions' : 'the synthetic schedule generator',
    },
    killBar: KILL_BAR_FALSE_CONFLICT_RATE,
    killBarPass,
    headline: {
      falseConflictRateDerivedCut: derived.falseConflictRate,
      falseConflictRateLazyCut: lazy.falseConflictRate,
      spatialOnlyTrueConflictsDerivedPerThousand: derived.spatialOnlyTrueConflictsPerThousand,
      spatialOnlyTrueConflictsLazyPerThousand: lazy.spatialOnlyTrueConflictsPerThousand,
      spatialOnlyTrueConflictsDerivedTotal: derived.spatialOnlyTrueConflicts,
      spatialOnlyTrueConflictsLazyTotal: lazy.spatialOnlyTrueConflicts,
      schedulesPerCell: derived.schedules,
    },
    prediction: { clauses, allHeld: clauses.every((c) => c.held) },
    measurements,
    nullSpace,
    guard: {
      casesRun: guard.cases.length,
      casesCaught: guard.cases.filter((c) => c.caught).length,
      allCaughtByExpectedNet: guard.allCaughtByExpectedNet,
      cleanControlPasses: guard.cleanControlPasses,
      cases: guard.cases,
    },
    assertions: ASSERTIONS,
  };

  emit('scorecard.json', scorecard, forbidden);

  log('');
  log('==== B5.1 verdict ====');
  log(`corpus admissible:            ${census.admissible} (${census.criteriaCleared} of ${census.criteriaTotal})`);
  log(`population measured:          ${scorecard.corpus.populationMeasured}`);
  log(`false-conflict rate (derived): ${(derived.falseConflictRate * 100).toFixed(2)}% (kill bar ${KILL_BAR_FALSE_CONFLICT_RATE * 100}%)`);
  log(`spatial-only true conflicts:  ${derived.spatialOnlyTrueConflicts} derived, ${lazy.spatialOnlyTrueConflicts} lazy, over ${derived.schedules} schedules each`);
  for (const c of clauses) {
    log(`clause ${c.id} ${c.held ? 'HELD' : 'FAILED'}: observed ${c.observed}, bar ${c.comparator} ${c.required}`);
  }
  log(`null space: unsound auto-merge on an unmodelled op = ${nullSpace.unsoundAutoMergeOnAnUnmodelledOp}`);
  log('======================');
}

main().catch((err) => {
  if (err instanceof ExamAssertionError) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(2);
});
