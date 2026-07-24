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
 * Usage: node scripts/moonshot/g2-merge-soundness.mjs [schedules] [seed] [epsilonMm]
 * Exit code 0 iff the exam passes (zero unsound auto-merges, zero
 * certificate verification failures) AND the kill criterion holds
 * (false-conflict rate < 20%).
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
