#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The content-matching validation fixture (issue #1891's instrument).
 *
 * Answers "does the matcher work", not "do its unit tests pass": it builds a
 * head revision of a real model whose true correspondence is known BY
 * CONSTRUCTION, runs the shipped matcher over the shipped fingerprints, and
 * scores precision and recall against that key — stratified by tier, by
 * mutation kind, and by geometry class.
 *
 * Usage:
 *   node scripts/xmatch/run.mjs                 # score, write the scorecard
 *   node scripts/xmatch/run.mjs --self-test     # mutation-check the harness
 *   node scripts/xmatch/run.mjs --write         # update the committed scorecard
 *   node scripts/xmatch/run.mjs --keep          # keep the generated head files
 *
 * Exit codes: 0 pass, 1 a threshold or guard failed, 2 could not run at all
 * (missing fixture, missing wasm, missing build).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintFile, GEOMETRY_HASH_TOLERANCE } from './fingerprints.mjs';
import { donorPairKey, incomparableSwaps } from './geometry-bounds.mjs';
import { mutateModel } from './mutate.mjs';
import {
  checkCorpusThresholds,
  checkThresholds,
  corpusTargetGaps,
  scorePair,
  targetGaps,
} from './score.mjs';
import { guardFailures, runGuards } from './guards.mjs';
import { replacer, report } from './run-report.mjs';
import { realMatcher, sameContentGroups, volumeSet } from './run-matcher.mjs';
import { checkInvariantTripwires } from './invariants.mjs';
import {
  alwaysAbstainMatcher,
  alwaysMatchMatcher,
  overEagerMatcher,
  overlapSuccessorMutant,
  respecifiedAsRenamedMutant,
  rotatedClaimsMutant,
  silentClaimsMutant,
} from './matchers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT_DIR = join(ROOT, '.xmatch-out');
const SCORECARD = join(HERE, 'scorecard.json');
const THRESHOLDS = JSON.parse(readFileSync(join(HERE, 'thresholds.json'), 'utf-8'));
const MAX_SWAP_ATTEMPTS = 16;

/**
 * The corpus. Each entry is one real model plus the seed its mutation is
 * derived from; both are part of the fixture's identity, so changing either is
 * a reviewed diff rather than a knob.
 */
const CORPUS = [
  // Nine detached elements own an extruded rectangle outright (the footings
  // and a few slabs); the split and the nearby control share them.
  {
    model: 'tests/models/ara3d/duplex.ifc',
    seed: 20260803,
    plan: { splitLength: 4, insertedNearby: 5 },
  },
  // 126 keyed elements, of which 17 (annotations, virtual elements) can never
  // be matched. Every element a new role takes out of `renamed` moves that
  // stratum's recall towards its floor — 7 is the most the 0.777 floor
  // allows — so the #4955 roles are sized down here and the corpus-wide
  // population floors are carried by the two larger models. Its 15
  // arbitrary-profile extrusions are not rectangles, so `thickened` and
  // `splitLength` have nothing to take anyway; the one count that costs no
  // recall is `insertedNearby`, which rides on elements already `deleted`
  // (and needs a rectangle too, so it is 0 here). `swapped` is 0 because the
  // only same-type donor maps in the model are the two window maps, and they
  // are mirror images of one symmetric window: the swap changes the file and
  // nothing about the world mesh, and the engine correctly pairs the result
  // as `respecified`. That is not a successor case and would be scored as one.
  {
    model: 'tests/models/ara3d/AC20-FZK-Haus.ifc',
    seed: 20260804,
    plan: { respecified: 4, thickened: 0, swapped: 0, splitLength: 0, insertedNearby: 0 },
  },
  // The large model carries the #4955 population floors: 59 detached
  // rectangle extrusions, 104 mapped bodies with a donor, 633 owned psets.
  {
    model: 'tests/models/various/rvt01.ifc',
    seed: 20260805,
    plan: { respecified: 20, thickened: 14, splitLength: 8, insertedNearby: 8 },
  },
];

const args = process.argv.slice(2);
const SELF_TEST = args.includes('--self-test');
const WRITE = args.includes('--write');
const KEEP = args.includes('--keep');

function fail(message) {
  process.stderr.write(`xmatch: ${message}\n`);
  process.exit(2);
}

/** Build one pair and everything the guards need to judge it. */
async function buildPair(entry, api) {
  const modelPath = join(ROOT, entry.model);
  if (!existsSync(modelPath)) {
    fail(`fixture missing: ${entry.model} — run \`pnpm fixtures\` first`);
  }
  const sourceText = readFileSync(modelPath, 'utf-8');
  const base = await fingerprintFile(modelPath, api);

  mkdirSync(OUT_DIR, { recursive: true });
  const headPath = join(OUT_DIR, `${entry.seed}-${entry.model.replaceAll('/', '_')}`);
  const geometryAabbs = new Map(
    base.fingerprints
      .filter((fingerprint) => fingerprint.aabb)
      .map((fingerprint) => [fingerprint.ref, fingerprint.aabb]),
  );
  const excludedDonors = new Set();
  // Base occurrence bounds are a cheap fail-closed prefilter. The generated
  // head is still authoritative: mapping targets and placements can make the
  // same map a different size at its recipient. Reject such a pair and replay
  // the seeded mutation without it; every retry excludes at least one finite
  // product/map pair, and the cap turns unexpected corpus drift into a loud
  // fixture failure rather than a false-positive answer key.
  for (let attempt = 1; attempt <= MAX_SWAP_ATTEMPTS; attempt++) {
    const { text: headText, key } = mutateModel(sourceText, {
      seed: entry.seed,
      meshedIds: base.meshedIds,
      population: base.fingerprints.map((fingerprint) => fingerprint.ref),
      geometryAabbs,
      excludedDonors,
      sameContentGroups: sameContentGroups(base),
      unitScale: base.unitScale,
      sourcePath: entry.model,
      plan: entry.plan,
    });
    writeFileSync(headPath, headText);
    const head = await fingerprintFile(headPath, api);
    const invalid = incomparableSwaps(key, base.fingerprints, head.fingerprints);
    if (invalid.length === 0) {
      const guards = runGuards(sourceText, headText, base, head, key);
      return { key, base, head, guards, headPath };
    }
    let added = 0;
    for (const swap of invalid) {
      if (!Number.isInteger(swap.donorMap)) continue;
      const size = excludedDonors.size;
      excludedDonors.add(donorPairKey(swap.base, swap.donorMap));
      if (excludedDonors.size > size) added++;
    }
    if (added === 0) fail(`swapped geometry has unusable bounds in ${entry.model}`);
    process.stdout.write(`  retrying ${entry.model}: rejected ${added} incomparable mapped donor(s)\n`);
  }
  fail(`no comparable mapped donors remained in ${entry.model} after ${MAX_SWAP_ATTEMPTS} attempts`);
}

async function main() {
  const wasmPath = join(ROOT, 'packages/wasm/pkg/ifc-lite_bg.wasm');
  if (!existsSync(wasmPath)) fail('packages/wasm/pkg/ifc-lite_bg.wasm missing — run `pnpm build:wasm`');
  if (!existsSync(join(ROOT, 'packages/cli/dist/commands/diff-engine.js'))) {
    fail('packages/cli is not built — run `pnpm turbo build --filter=./packages/*`');
  }
  const { initSync, IfcAPI } = await import('../../packages/wasm/pkg/ifc-lite.js');
  initSync({ module: readFileSync(wasmPath) });
  const api = new IfcAPI();
  api.setComputeGeometryHashes(GEOMETRY_HASH_TOLERANCE);

  // Before any model is touched: do the generator's own refusals still fire?
  // A corrupt answer key that scores green is worse than no fixture, and these
  // are the three places that can detect one. Pure and fixture-free, so it is
  // the cheapest check here and the first to run.
  if (SELF_TEST) {
    const tripwires = checkInvariantTripwires();
    for (const failure of tripwires) process.stdout.write(`  invariant ${failure}\n`);
    process.stdout.write(
      `  invariant tripwires: ${tripwires.length === 0 ? 'all trip' : `${tripwires.length} BROKEN`}\n`,
    );
    if (tripwires.length > 0) {
      process.stderr.write('xmatch: the generator no longer refuses a corrupt answer key\n');
      process.exit(1);
    }
  }

  const started = Date.now();
  const pairs = [];
  let failed = false;
  // Tracked apart from `failed` on purpose. `--self-test` asks one question —
  // can this harness reject a matcher that is obviously wrong — and its answer
  // must not depend on whether the REAL matcher currently clears its floors.
  // Inheriting that would make the mutation check unreadable exactly when the
  // scored run is red, which is when it matters most.
  let harnessBroken = false;
  /** Every mutant must have been APPLIED somewhere: one that was "not
   *  applicable" on every pair was never tested. */
  const mutantsApplied = new Set();
  const ALL_MUTANTS = [
    'always-match',
    'always-abstain',
    'over-eager',
    'overlap-successor',
    'rotated-claims',
    'respecified-as-renamed',
    'silent-claims',
  ];

  for (const entry of CORPUS) {
    const { key, base, head, guards, headPath } = await buildPair(entry, api);
    const fixtureFailures = guardFailures(guards);
    const real = realMatcher(base.fingerprints, head.fingerprints);
    const { matches } = real;
    const scoreOptions = (result) => ({
      typeOf: new Map(base.fingerprints.map((f) => [f.ref, f.ifcType])),
      splitMerges: result.splitMerges ?? [],
      successors: result.successors ?? [],
      hasVolume: volumeSet(base, head),
    });
    const score = scorePair(key, matches, scoreOptions(real));
    const checked =
      fixtureFailures.length > 0
        ? { failures: [], skipped: [] }
        : checkThresholds(score, THRESHOLDS.perPair);

    if (SELF_TEST) {
      // The content mutants keep the real engine's claim stages, so what
      // rejects them is content matching; the claim mutants keep the real
      // content matches and each must be rejected by the clause family it
      // was written against (`mustFailOn`), not merely by something.
      const withRealClaims = (result) => ({
        ...result,
        splitMerges: real.splitMerges,
        successors: real.successors,
      });
      const mutants = [
        ['always-match', { result: withRealClaims(alwaysMatchMatcher(base.fingerprints, head.fingerprints)) }],
        ['always-abstain', { result: withRealClaims(alwaysAbstainMatcher()) }],
        // Strictly better recall than the engine, bought with false pairs.
        // If this survives, a recall floor can be met by lowering the bar.
        [
          'over-eager',
          { result: withRealClaims(overEagerMatcher(base.fingerprints, head.fingerprints, matches)) },
        ],
        ['overlap-successor', overlapSuccessorMutant(base.fingerprints, head.fingerprints, real)],
        ['rotated-claims', rotatedClaimsMutant(head.fingerprints, real, key)],
        ['respecified-as-renamed', respecifiedAsRenamedMutant(real)],
        ['silent-claims', silentClaimsMutant(real, key)],
      ];
      const survivors = [];
      for (const [name, mutant] of mutants) {
        if (mutant.applicable === false) {
          process.stdout.write(`  mutant ${name.padEnd(22)} not applicable on this pair (no material)\n`);
          continue;
        }
        mutantsApplied.add(name);
        const result = mutant.result;
        const mutantScore = scorePair(key, result.matches, scoreOptions(result));
        // PER-PAIR clauses ONLY. Feeding one pair to `checkCorpusThresholds`
        // used to add the corpus `populations` clauses, which are derived from
        // `key.elements` and never touch `matches` at all — so on the two
        // models that do not individually meet a corpus-scale population
        // (AC20 has renamed 84 < 200, retriangulated 0 < 8, inserted 4 < 12;
        // rvt01 has retriangulated 0 < 8) EVERY mutant was rejected before its
        // matching behaviour was examined, and `failures.length === 0` could
        // not occur however good the mutant was. The mutation check proved
        // nothing on those two pairs. It now scores mutants exclusively on
        // clauses that are a function of what the matcher returned.
        const mutantFailures = checkThresholds(mutantScore, THRESHOLDS.perPair).failures;
        const targeted =
          mutant.mustFailOn === undefined || mutantFailures.some((clause) => mutant.mustFailOn.test(clause));
        if (mutantFailures.length === 0) survivors.push(name);
        else if (!targeted) survivors.push(`${name} (rejected, but not by ${mutant.mustFailOn})`);
        // Recall and precision are printed next to the verdict so the
        // over-eager mutant's claim is visible rather than asserted: it must
        // show HIGHER recall than the real matcher and lower precision, which
        // is the trade a recall floor alone would reward.
        process.stdout.write(
          `  mutant ${name.padEnd(22)} recall ${String(mutantScore.overall.recall).padEnd(9)}` +
            ` precision ${String(mutantScore.overall.precision).padEnd(9)} ${
              mutantFailures.length === 0
                ? 'PASSED (harness is broken)'
                : `failed on ${mutantFailures.length} clause(s)${
                    targeted ? '' : ', NONE in the targeted family'
                  }`
            }\n`,
        );
        // The negative-control and calibration clauses are printed whatever
        // else fails: an always-match mutant that scored badly on RATES but
        // never tripped "you paired a deleted element" would mean the hard
        // controls are decorative.
        const named = mutantFailures.filter((clause) =>
          /^(falsePairs|falseSuccessors|calibration|respecifiedControl)\./.test(clause),
        );
        for (const clause of new Set([...mutantFailures.slice(0, 3), ...named])) {
          process.stdout.write(`      ${clause}\n`);
        }
      }
      if (survivors.length > 0) {
        harnessBroken = true;
        fixtureFailures.push(`mutation check: ${survivors.join(', ')} passed the thresholds`);
      }
    }

    if (fixtureFailures.length > 0 || checked.failures.length > 0) failed = true;
    pairs.push({
      model: entry.model,
      seed: entry.seed,
      schema: base.schemaVersion,
      unitScale: base.unitScale,
      guards,
      fixtureFailures,
      thresholdFailures: checked.failures,
      thresholdsSkipped: checked.skipped,
      targetGaps: targetGaps(score, THRESHOLDS.preRegisteredTargets),
      applied: key.applied,
      score,
    });
    if (!KEEP) rmSync(headPath, { force: true });
  }

  const corpusFailures = checkCorpusThresholds(
    pairs.map((pair) => pair.score),
    THRESHOLDS.corpus,
  );
  if (corpusFailures.length > 0) failed = true;

  const corpusGaps = corpusTargetGaps(
    pairs.map((pair) => pair.score),
    THRESHOLDS.preRegisteredTargets,
  );

  const scorecard = {
    fixture: 'content-matching validation (#1891)',
    spec: 'scripts/xmatch/SPEC.md',
    generatedBy: 'node scripts/xmatch/run.mjs',
    thresholdsSha256: createHash('sha256')
      .update(readFileSync(join(HERE, 'thresholds.json')))
      .digest('hex'),
    geometryHashToleranceMetres: GEOMETRY_HASH_TOLERANCE,
    verdict: failed ? 'FAIL' : 'PASS',
    corpusFailures,
    corpusTargetGaps: corpusGaps,
    durationSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    pairs,
  };

  // `report()` prints a block per corpus pair, so stdout here holds far more
  // than a pipe buffer — and on a pipe (every CI log) stdout is asynchronous.
  // A bare `process.exit()` tears the process down with that remainder still
  // queued, cutting the log off mid-report without the verdict line, which is
  // the only part anyone reads. So exit from the write CALLBACK: writes are
  // ordered, so it fires only once everything before it has reached the pipe.
  // Setting `process.exitCode` and returning would flush too, but this run
  // holds a live IfcAPI, and an immediate exit is what keeps a lingering
  // handle from parking the job instead of ending it.
  report(scorecard);
  if (SELF_TEST) {
    const neverApplied = ALL_MUTANTS.filter((name) => !mutantsApplied.has(name));
    for (const name of neverApplied) process.stdout.write(`mutant ${name} was not applicable on ANY pair\n`);
    const broken =
      harnessBroken || neverApplied.length > 0 || pairs.some((pair) => pair.fixtureFailures.length > 0);
    process.stdout.write(
      `\nself-test: ${
        broken
          ? 'FAIL — the harness cannot be trusted'
          : 'PASS — every mutant rejected wherever applicable, on per-pair clauses alone'
      }\n`,
      () => process.exit(broken ? 1 : 0),
    );
    return;
  }
  if (WRITE) {
    writeFileSync(SCORECARD, `${JSON.stringify(scorecard, replacer, 2)}\n`);
    process.stdout.write(`\nwrote ${SCORECARD}\n`);
  }
  process.stdout.write('', () => process.exit(failed ? 1 : 0));
}

main().catch((error) => {
  process.stderr.write(`xmatch: ${error?.stack ?? error}\n`);
  process.exit(2);
});
