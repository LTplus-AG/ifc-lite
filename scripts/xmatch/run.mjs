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
import { diffModels } from '../../packages/diff/dist/index.js';
import { fingerprintFile, GEOMETRY_HASH_TOLERANCE } from './fingerprints.mjs';
import { mutateModel } from './mutate.mjs';
import { checkCorpusThresholds, checkThresholds, scorePair, targetGaps } from './score.mjs';
import { guardFailures, runGuards } from './guards.mjs';
import { checkInvariantTripwires } from './invariants.mjs';
import { alwaysAbstainMatcher, alwaysMatchMatcher, overEagerMatcher } from './matchers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT_DIR = join(ROOT, '.xmatch-out');
const SCORECARD = join(HERE, 'scorecard.json');
const THRESHOLDS = JSON.parse(readFileSync(join(HERE, 'thresholds.json'), 'utf-8'));

/**
 * The corpus. Each entry is one real model plus the seed its mutation is
 * derived from; both are part of the fixture's identity, so changing either is
 * a reviewed diff rather than a knob.
 */
const CORPUS = [
  { model: 'tests/models/ara3d/duplex.ifc', seed: 20260803 },
  { model: 'tests/models/ara3d/AC20-FZK-Haus.ifc', seed: 20260804 },
  { model: 'tests/models/various/rvt01.ifc', seed: 20260805 },
];

const args = process.argv.slice(2);
const SELF_TEST = args.includes('--self-test');
const WRITE = args.includes('--write');
const KEEP = args.includes('--keep');

/** The matcher under test: the shipped engine, at viewer scope. */
function realMatcher(base, head) {
  const diff = diffModels(base, head, { scope: 'both', matchUnpairedByContent: true });
  return { matches: diff.contentMatches ?? [], counts: diff.counts };
}

/**
 * Meshed elements that share an (`ifcType`, `dataHash`) bucket, largest first.
 *
 * A BASE-side fact only — the mutation program uses it to pick which group to
 * move wholesale, and the answer key still records what it did rather than
 * what any hash later says. Passing the head's hashes in here would be the
 * circularity this fixture is built to avoid.
 */
function sameContentGroups(base) {
  const groups = new Map();
  for (const fingerprint of base.fingerprints) {
    if (!base.meshedIds.has(fingerprint.ref)) continue;
    const bucket = `${fingerprint.ifcType}\u0000${fingerprint.dataHash}`;
    const list = groups.get(bucket);
    if (list) list.push(fingerprint.ref);
    else groups.set(bucket, [fingerprint.ref]);
  }
  return [...groups.values()].filter((list) => list.length >= 3).sort((a, b) => b.length - a.length);
}

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

  const { text: headText, key } = mutateModel(sourceText, {
    seed: entry.seed,
    meshedIds: base.meshedIds,
    population: base.fingerprints.map((fingerprint) => fingerprint.ref),
    sameContentGroups: sameContentGroups(base),
    unitScale: base.unitScale,
    sourcePath: entry.model,
  });

  mkdirSync(OUT_DIR, { recursive: true });
  const headPath = join(OUT_DIR, `${entry.seed}-${entry.model.replaceAll('/', '_')}`);
  writeFileSync(headPath, headText);
  const head = await fingerprintFile(headPath, api);

  const guards = runGuards(sourceText, headText, base, head, key);
  return { key, base, head, guards, headPath };
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

  for (const entry of CORPUS) {
    const { key, base, head, guards, headPath } = await buildPair(entry, api);
    const fixtureFailures = guardFailures(guards);
    const { matches } = realMatcher(base.fingerprints, head.fingerprints);
    const score = scorePair(key, matches, {
      typeOf: new Map(base.fingerprints.map((f) => [f.ref, f.ifcType])),
    });
    const checked =
      fixtureFailures.length > 0
        ? { failures: [], skipped: [] }
        : checkThresholds(score, THRESHOLDS.perPair);

    if (SELF_TEST) {
      const mutants = [
        ['always-match', alwaysMatchMatcher(base.fingerprints, head.fingerprints)],
        ['always-abstain', alwaysAbstainMatcher()],
        // Strictly better recall than the engine, bought with false pairs.
        // If this survives, a recall floor can be met by lowering the bar.
        ['over-eager', overEagerMatcher(base.fingerprints, head.fingerprints, matches)],
      ];
      const survivors = [];
      for (const [name, result] of mutants) {
        const mutantScore = scorePair(key, result.matches, {
          typeOf: new Map(base.fingerprints.map((f) => [f.ref, f.ifcType])),
        });
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
        if (mutantFailures.length === 0) survivors.push(name);
        // Recall and precision are printed next to the verdict so the
        // over-eager mutant's claim is visible rather than asserted: it must
        // show HIGHER recall than the real matcher and lower precision, which
        // is the trade a recall floor alone would reward.
        process.stdout.write(
          `  mutant ${name.padEnd(15)} recall ${String(mutantScore.overall.recall).padEnd(9)}` +
            ` precision ${String(mutantScore.overall.precision).padEnd(9)} ${
              mutantFailures.length === 0
                ? 'PASSED (harness is broken)'
                : `failed on ${mutantFailures.length} clause(s)`
            }\n`,
        );
        // The negative-control and calibration clauses are printed whatever
        // else fails: an always-match mutant that scored badly on RATES but
        // never tripped "you paired a deleted element" would mean the hard
        // controls are decorative.
        const named = mutantFailures.filter((clause) => /^(falsePairs|calibration)\./.test(clause));
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
    durationSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    pairs,
  };

  report(scorecard);
  if (SELF_TEST) {
    const broken = harnessBroken || pairs.some((pair) => pair.fixtureFailures.length > 0);
    process.stdout.write(
      `\nself-test: ${
        broken
          ? 'FAIL — the harness cannot be trusted'
          : 'PASS — all three mutants rejected on every pair, on per-pair clauses alone'
      }\n`,
    );
    process.exit(broken ? 1 : 0);
  }
  if (WRITE) {
    writeFileSync(SCORECARD, `${JSON.stringify(scorecard, replacer, 2)}\n`);
    process.stdout.write(`\nwrote ${SCORECARD}\n`);
  }
  process.exit(failed ? 1 : 0);
}

/** Durations are wall clock and would churn the committed artifact on every
 *  run; the scorecard keeps the measurements, not the stopwatch. */
function replacer(key, value) {
  return key === 'durationSeconds' ? undefined : value;
}

function report(scorecard) {
  const line = (text) => process.stdout.write(`${text}\n`);
  for (const pair of scorecard.pairs) {
    line('');
    line(`${pair.model}  (seed ${pair.seed}, ${pair.schema})`);
    line(`  applied: ${JSON.stringify(pair.applied)}`);
    const score = pair.score;
    line(
      `  overall  precision ${score.overall.precision}  recall ${score.overall.recall}` +
        `  (${score.overall.correctPairs}/${score.overall.claimedPairs} pairs, ` +
        `${score.overall.recalled}/${score.overall.recallPopulation} elements, ` +
        `${score.overall.abstained} abstained)`,
    );
    for (const [tier, row] of Object.entries(score.byTier)) {
      line(`  tier  ${tier.padEnd(14)} claimed ${String(row.claimed).padStart(5)}  precision ${row.precision}`);
    }
    for (const [kind, row] of Object.entries(score.byKind)) {
      line(
        `  kind  ${kind.padEnd(14)} n=${String(row.population).padStart(4)}  recall ${row.recall}` +
          `  precision ${row.precision}  kindAgreement ${row.kindAgreement}`,
      );
    }
    for (const [name, row] of Object.entries(score.byClass)) {
      line(`  class ${name.padEnd(14)} n=${String(row.population).padStart(4)}  recall ${row.recall}  precision ${row.precision}`);
    }
    line(
      `  calibration  population ${score.calibration.population}` +
        `  matchedByGeometryHash ${score.calibration.matchedByGeometryHash.length}` +
        `  reportedRenamed ${score.calibration.reportedRenamed.length}` +
        `  recoveredByLowerTiers ${score.calibration.recoveredByLowerTiers}`,
    );
    line(`  negative controls  ${JSON.stringify(score.falsePairs)}`);
    line(
      `  missed  abstained ${score.missed.abstained}  silent ${score.missed.silent}` +
        `  ${JSON.stringify(score.missed.byType)}`,
    );
    line(`  duplicates contained ${score.duplicateContainment.contained}/${score.duplicateContainment.population}`);
    line(`  move distance agreement ${score.moveDistance.agreed}/${score.moveDistance.checked}`);
    for (const skip of pair.thresholdsSkipped) line(`  skipped: ${skip}`);
    for (const gap of pair.targetGaps) line(`  BELOW PRE-REGISTERED TARGET: ${gap}`);
    for (const failure of pair.fixtureFailures) line(`  FIXTURE FAILURE: ${failure}`);
    for (const failure of pair.thresholdFailures) line(`  THRESHOLD FAILURE: ${failure}`);
  }
  line('');
  for (const failure of scorecard.corpusFailures) line(`CORPUS FAILURE: ${failure}`);
  line(`verdict: ${scorecard.verdict}`);
}

main().catch((error) => {
  process.stderr.write(`xmatch: ${error?.stack ?? error}\n`);
  process.exit(2);
});
