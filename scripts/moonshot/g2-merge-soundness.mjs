#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * G2 merge soundness gate for Bet B2.1 (docs/vision/moonshots-execution-plan.md
 * Phase 2, "Merge soundness contract (M4): commutation certificates +
 * conflict predicates + the 1,000-schedule property battery").
 *
 * Runs the M4 midterm exam exactly as specified in section 2 M4.8:
 * "soundness property test, 1,000 randomized two-client op schedules, zero
 * unsound auto-merges (an auto-merge whose replay differs from sequential
 * application), with conflict rate reported" -- via
 * `@ifc-lite/provenance`'s `runMergeBattery` (seeded mulberry32 PRNG,
 * reproducible; every auto-merge is backed by a commutation certificate
 * whose internal check replays BOTH orders and requires byte-identical
 * convergence, and a sample of certificates is independently re-verified).
 *
 * Also measures the M4 kill-criterion quantity (plan section 5): the
 * false-conflict rate, computed against ground truth where ground truth is
 * computable -- a flagged schedule whose two orders both replay cleanly AND
 * converge byte-identically was a false conflict. Denominator: every
 * schedule whose ground truth is "commutes" (auto-merged + false conflicts).
 *
 * Since Bet B4.2 the report also carries the SPATIAL DECOMPOSITION that the
 * G2 red-team review (docs/vision/reviews/g2-red-team-2026-07-24.md section 4)
 * had to compute by hand: flagged schedules split by which half of the
 * predicate fired, with ground truth per class. Two numbers matter there --
 * the false-conflict rate restricted to schedules where the spatial rule
 * fired, and the count of conflicts that ONLY the spatial rule caught. The
 * second one is a kill number: under the v0 per-node op model it was provably
 * zero (node-disjoint ops always commuted), which made the spatial rule
 * unfalsifiable; if coupled semantics leave it at zero, the rule is deleted.
 *
 * Usage: node scripts/moonshot/g2-merge-soundness.mjs [schedules] [seed] [epsilonMm]
 * Exit code 0 iff the exam passes (zero unsound auto-merges, zero
 * certificate verification failures) AND the kill criterion holds
 * (false-conflict rate < 20%). The restricted spatial rate is REPORTED
 * against the same 20% bar but deliberately does not gate the exit: the
 * plan's kill criterion is stated over the whole distribution, and turning a
 * sub-population measurement into a gate would change the exam under itself.
 * It is printed with an explicit PASS/FAIL so a red number cannot pass
 * unnoticed, and it is byte-compared by the B4.1 standing-evidence lane.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const { runMergeBattery, DEFAULT_EPSILON_MM } = await import(
  path.join(REPO_ROOT, 'packages/provenance/dist/index.js')
);

const SCHEDULES = Number(process.argv[2] ?? 1000);
const SEED = Number(process.argv[3] ?? 20260724);
const EPSILON_MM = Number(process.argv[4] ?? DEFAULT_EPSILON_MM);
// Fail fast on "1k"-style typos: NaN would zero the loop and print a
// misleading PASS over zero schedules.
if (!Number.isInteger(SCHEDULES) || SCHEDULES < 1) {
  console.error(`error: schedules must be a positive integer, got ${JSON.stringify(process.argv[2])}`);
  process.exit(2);
}
if (!Number.isInteger(SEED) || SEED < 0) {
  console.error(`error: seed must be a non-negative integer, got ${JSON.stringify(process.argv[3])}`);
  process.exit(2);
}
if (!Number.isFinite(EPSILON_MM) || EPSILON_MM < 0) {
  console.error(`error: epsilonMm must be a non-negative number, got ${JSON.stringify(process.argv[4])}`);
  process.exit(2);
}

function pct(x) {
  return `${(x * 100).toFixed(2)}%`;
}

async function main() {
  console.error(`[g2-merge] schedules: ${SCHEDULES}, seed: ${SEED}, epsilonMm: ${EPSILON_MM}`);
  const report = await runMergeBattery({ schedules: SCHEDULES, seed: SEED, epsilonMm: EPSILON_MM });

  console.error('');
  console.error('==== G2 merge soundness verdict (M4 midterm, Bet B2.1) ====');
  console.error(`schedules run:         ${report.schedules}`);
  console.error(`auto-merged:           ${report.autoMerged} (each backed by a commutation certificate)`);
  console.error(`unsound auto-merges:   ${report.unsoundAutoMerges}   (exam bar: exactly 0)`);
  if (report.unsoundAutoMerges > 0) {
    console.error(`  unsound schedule indices: ${report.unsoundScheduleIndices.join(', ')}`);
  }
  console.error(`flagged conflicts:     ${report.flaggedConflicts} (conflict rate ${pct(report.conflictRate)})`);
  console.error(`  true conflicts:      ${report.trueConflicts} (replay fails or diverges -- correctly blocked)`);
  console.error(`  false conflicts:     ${report.falseConflicts} (both orders converge -- over-approximation)`);
  console.error(
    `false-conflict rate:   ${pct(report.falseConflictRate)} of ${report.groundTruthConvergent} ground-truth-commuting schedules (kill criterion: < 20%)`,
  );
  console.error('');
  console.error('---- spatial decomposition (B4.2) ----');
  const { structuralOnly, spatialOnly, both } = report.byRule;
  const row = (label, t) =>
    `${label.padEnd(18)} flagged ${String(t.flagged).padStart(4)}  true ${String(t.trueConflicts).padStart(4)}` +
    ` (apply-failed ${t.trueApplyFailed}, diverged ${t.trueDiverged})  false ${String(t.falseConflicts).padStart(4)}`;
  console.error(row('structural-only:', structuralOnly));
  console.error(row('spatial-only:', spatialOnly));
  console.error(row('both rules:', both));
  console.error(
    `restricted false-conflict rate: ${pct(report.spatialFiredFalseConflictRate)} of ${report.spatialFiredFlagged} schedules where the spatial rule fired` +
      ` -- ${report.spatialKillCriterionPass ? 'PASS' : 'FAIL'} against the < 20% bar (reported, not gating)`,
  );
  console.error(
    `spatial-ONLY true conflicts:    ${report.spatialOnlyTrueConflicts}  (v0 op model: provably 0 -- the spatial rule could not be right about anything)`,
  );
  console.error(
    `spatial rule verdict:  ${report.spatialRuleContributes ? 'KEEP -- it catches conflicts nothing else does' : 'DELETE -- a predicate that never fires truthfully is not a contribution'}`,
  );
  console.error('--------------------------------------');
  console.error('');
  console.error(
    `certificates:          ${report.certificatesIssued} issued, ${report.certificatesVerified} independently verified, ${report.certificateFailures} failures`,
  );
  console.error(`elapsed:               ${(report.elapsedMs / 1000).toFixed(1)}s`);
  console.error(`M4 midterm exam:       ${report.examPass ? 'PASS' : 'FAIL'} (zero unsound auto-merges, zero certificate failures)`);
  console.error(`M4 kill criterion:     ${report.killCriterionPass ? 'PASS' : 'FAIL'} (false-conflict rate < 20%)`);
  console.error('===========================================================');

  console.log(JSON.stringify(report));
  if (!report.examPass || !report.killCriterionPass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
