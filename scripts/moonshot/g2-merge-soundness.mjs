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
 * Two things the G4 red-team review (docs/vision/reviews/g4-red-team-2026-07-29.md
 * section 7 items 5 and 6) required, both standing numbers here:
 *
 * - **The ablation.** The soundness argument for the coupled semantics DEPENDS
 *   on the spatial rule, so the experiment that tests it is to remove the rule
 *   and count the unsound auto-merges that result -- `runSpatialAblation`, the
 *   same 1,000 schedules with the predicate reduced to structural overlap.
 *   "Unsound auto-merge" here means what it means in the exam bar above: the
 *   predicate cleared a pair that does not commute. No unsound CERTIFICATE is
 *   emitted in either mode (the certificate function replays both orders and
 *   refuses); the count measures the predicate, which is the thing the bet is
 *   about. Non-zero means the rule is load-bearing for the PREDICATE; zero
 *   means the predicate does not need it, which is a real negative result and
 *   is printed as one.
 * - **The two ratios, with their denominators named.** The headline rate and
 *   the spatial-restricted rate are DIFFERENT RATIOS (a false-positive rate
 *   over commuting schedules vs a precision-complement over flagged
 *   schedules). They are printed side by side with denominators spelled out,
 *   the restricted one with its Wilson 95% interval, and with an explicit
 *   statement of which one the plan's < 20% bar is defined over.
 *
 * And one thing the adversarial RE-review of G4 required (item 7), also a
 * standing number here:
 *
 * - **The ablation's headline never appears without its sensitivity.** The 9
 *   is not 9 independent findings; it is a property of two modelling choices
 *   in merge-model.ts, neither of which is IFC. `runDerivedCutSensitivity`
 *   re-scores the same schedules across the 2x2 of {cuts: lazy | derived} x
 *   {containment: enforced | off} and this script prints that grid in the same
 *   block as the 9, so the two cannot be separated in a quotation. It also
 *   restates what the rule buys in the only terms the artifact supports:
 *   replay-cost avoidance on the schedules the spatial rule alone refuses, at
 *   the price of the false refusals among them. It does NOT buy soundness of
 *   the certificate -- `createCommutationCertificate` replays both orders
 *   regardless of the predicate, in both modes.
 *
 * Usage: node scripts/moonshot/g2-merge-soundness.mjs [schedules] [seed] [epsilonMm]
 * Exit code 0 iff the exam passes (zero unsound auto-merges, zero
 * certificate verification failures) AND the kill criterion holds
 * (false-conflict rate < 20%). The restricted spatial rate is REPORTED
 * against the same 20% bar but deliberately does not gate the exit: the
 * plan's kill criterion is stated over the whole distribution, and turning a
 * sub-population measurement into a gate would change the exam under itself.
 * It is printed with an explicit PASS/FAIL so a red number cannot pass
 * unnoticed, and it is byte-compared by the B4.1 standing-evidence lane. The
 * ablation does not gate either, in either direction: it is a measurement of
 * the predicate, and an ablated run is EXPECTED to produce unsound merges.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const { runMergeBattery, runSpatialAblation, runDerivedCutSensitivity, wilsonInterval, DEFAULT_EPSILON_MM } =
  await import(path.join(REPO_ROOT, 'packages/provenance/dist/index.js'));

/**
 * The PRE-B4.2 headline, quoted here only so the distribution-change note can
 * be stated in the same place as the current number. Source, named because
 * nothing in this repository recomputes it (the generative model it was
 * measured on no longer exists): docs/vision/reviews/g2-red-team-2026-07-24.md
 * section 4, "reproduces 10.63% (101/950)", same seed 20260724.
 */
const PRE_B42_HEADLINE = { falseConflicts: 101, groundTruthConvergent: 950, source: 'g2-red-team-2026-07-24.md section 4' };

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

/** True when the run is the one the committed per-case readings were derived
 *  on. Any hand-derived, single-schedule explanation in this artifact is
 *  printed only under this flag -- at other parameters it would be an
 *  unverified claim wearing the authority of a gate. */
const AT_GATE_DEFAULTS = SCHEDULES === 1000 && SEED === 20260724 && EPSILON_MM === DEFAULT_EPSILON_MM;

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
    `false-conflict rate:   ${pct(report.falseConflictRate)} of ${report.groundTruthConvergent} ground-truth-commuting schedules (kill criterion: < 20%; ratio [1] below)`,
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
    `spatial-ONLY true conflicts:    ${report.spatialOnlyTrueConflicts}  (v0 op model: provably 0 -- the spatial rule could not be right about anything)`,
  );
  console.error('--------------------------------------');

  /* ---- G4 item 5: the ratios, with their denominators named ---------- */

  const flaggedRate = report.flaggedConflicts === 0 ? 0 : report.falseConflicts / report.flaggedConflicts;
  const wilson = wilsonInterval(report.spatialFiredFalseConflicts, report.spatialFiredFlagged);
  const preRate = PRE_B42_HEADLINE.falseConflicts / PRE_B42_HEADLINE.groundTruthConvergent;

  console.error('');
  console.error('---- false-conflict ratios: THREE denominators, spelled out (G4 item 5) ----');
  console.error(
    `[1] headline false-conflict rate         ${pct(report.falseConflictRate).padStart(7)}` +
      ` = ${report.falseConflicts} false / ${report.groundTruthConvergent} ground-truth-COMMUTING schedules` +
      ` (${report.autoMerged} auto-merged + ${report.falseConflicts} false)`,
  );
  console.error(
    `[2] precision-complement, all flagged    ${pct(flaggedRate).padStart(7)}` +
      ` = ${report.falseConflicts} false / ${report.flaggedConflicts} FLAGGED schedules`,
  );
  console.error(
    `[3] precision-complement, spatial fired  ${pct(report.spatialFiredFalseConflictRate).padStart(7)}` +
      ` = ${report.spatialFiredFalseConflicts} false / ${report.spatialFiredFlagged} FLAGGED schedules where the spatial rule fired`,
  );
  console.error(`    Wilson 95% CI on [3]:                [${pct(wilson.low)}, ${pct(wilson.high)}]`);
  console.error('');
  console.error("the plan's < 20% kill criterion (execution plan section 5, M4) is defined over [1]'s");
  console.error('denominator -- ground-truth-commuting schedules. Against it: ' +
    `${report.killCriterionPass ? 'PASS' : 'FAIL'} at ${pct(report.falseConflictRate)}.`);
  console.error('[3] is like-for-like with [2], NOT with [1]. [1] is a false-POSITIVE rate over');
  console.error('schedules that actually commute; [2] and [3] are precision-complements over');
  console.error('schedules the predicate flagged. Reading [3] against [1], or against a bar');
  console.error("defined over [1]'s denominator, is a denominator switch, not a comparison.");
  // Three-way, not two-way: equality is its own verdict. Collapsing it into
  // "NOT lower / over-approximates MORE" would print a strictly-worse claim
  // than the numbers support -- including in the degenerate case where both
  // rates are 0 and the honest reading is "no difference to report".
  const delta = report.spatialFiredFalseConflictRate - flaggedRate;
  const direction = delta < 0 ? 'lower' : delta > 0 ? 'higher' : 'equal';
  console.error(
    `against its own unrestricted analogue [2] = ${pct(flaggedRate)}, the spatial-fired rate [3]` +
      ` ${direction === 'lower' ? 'is LOWER' : direction === 'higher' ? 'is HIGHER' : 'is EQUAL'}:`,
  );
  console.error(
    direction === 'equal'
      ? 'the spatial rule over-approximates NEITHER MORE NOR LESS than the predicate as a whole.'
      : `the spatial rule over-approximates ${direction === 'lower' ? 'LESS' : 'MORE'} than the predicate as a whole.`,
  );
  console.error(
    `B4.2 nonetheless measured [3] against the same numeric < 20% bar and reported` +
      ` ${report.spatialKillCriterionPass ? 'PASS' : 'FAIL'}.`,
  );
  console.error(
    `that stands on its own terms -- the Wilson interval` +
      ` ${wilson.low > 0.2 || wilson.high < 0.2 ? 'EXCLUDES' : 'INCLUDES'} 20% -- but it is a bar the plan`,
  );
  console.error('did not define for this denominator. Reported, not gating.');
  console.error('');
  console.error(
    `DISTRIBUTION CHANGE, NOT AN IMPROVEMENT: the pre-B4.2 headline was ${pct(preRate)}` +
      ` (${PRE_B42_HEADLINE.falseConflicts}/${PRE_B42_HEADLINE.groundTruthConvergent},`,
  );
  console.error(`same seed; source: ${PRE_B42_HEADLINE.source}); [1] is now`);
  console.error(
    `${pct(report.falseConflictRate)} (${report.falseConflicts}/${report.groundTruthConvergent}).` +
      ' The BASE MODEL changed with B4.2 -- it now plants a hosted opening in',
  );
  console.error('every second grid element and 35% of entity-adds create a new opening -- so');
  console.error(
    `${pct(preRate)} and ${pct(report.falseConflictRate)} are measured on different generative models.` +
      ' The arrow between',
  );
  console.error('them is a distribution change and must not be quoted as a tightening of the predicate.');
  console.error('---------------------------------------------------------------------------');

  /* ---- G4 item 6: the ablation -------------------------------------- */

  console.error('');
  console.error(`[g2-merge] ablation: re-running the same ${SCHEDULES} schedules with the spatial rule DISABLED...`);
  const ablation = await runSpatialAblation({ schedules: SCHEDULES, seed: SEED, epsilonMm: EPSILON_MM });

  console.error('');
  console.error('---- ABLATION: same schedules, spatial rule DISABLED (G4 item 6) ----');
  console.error('one variable changed: the conflict predicate is reduced to structural overlap.');
  console.error('the op model is untouched -- hosts still reject openings that escape them, and');
  console.error('void cuts are still lazy.');
  console.error(`auto-merged (ablated):   ${ablation.autoMerged}`);
  console.error(`flagged (ablated):       ${ablation.flaggedConflicts}  (structural overlap alone)`);
  console.error(
    `UNSOUND AUTO-MERGES:     ${ablation.unsoundAutoMerges}  <- the predicate said "safe" and the replay then` +
      ` failed (${ablation.unsoundApplyFailed}) or diverged (${ablation.unsoundDiverged})`,
  );
  console.error('  (same units as the exam bar above, which reads 0 WITH the rule. no unsound');
  console.error('  certificate is emitted in either mode: createCommutationCertificate replays both');
  console.error('  orders itself and refuses. what this counts is the PREDICATE -- the deciding');
  console.error('  part, and the part B4.2 is about -- being wrong in the unsafe direction.)');
  if (ablation.unsoundAutoMerges > 0) {
    console.error(`  schedule indices:      ${ablation.unsoundScheduleIndices.join(', ')}`);
    console.error(
      `  caught by the spatial rule when enabled: ${ablation.unsoundCaughtBySpatialRule} of ${ablation.unsoundAutoMerges}` +
        `${ablation.spatialRuleCatchesAll ? '' : '  <-- MISSED ONE: the SHIPPING predicate is unsound too'}`,
    );
  }
  if (ablation.spatialRuleIsLoadBearing) {
    console.error('verdict: the spatial rule is LOAD-BEARING FOR THE PREDICATE under this op model.');
    console.error('  NOT for the certificate: the replay backstop refuses these pairs in both modes,');
    console.error(`  and this ablated run issued ${ablation.certificatesIssued} certificates with ${ablation.certificateFailures} failures.`);
    console.error(
      `  identity, by construction and pinned by a test: ablated unsound (${ablation.unsoundAutoMerges})` +
        ` == spatial-ONLY true conflicts (${report.spatialOnlyTrueConflicts}).`,
    );
    console.error('  a schedule only the spatial rule flags has no structural conflict at all, so the');
    console.error('  ablated predicate clears it; if its ground truth is "does not commute", the');
    console.error('  predicate was wrong in the unsafe direction. So the plan\'s "delete iff zero"');
    console.error('  threshold is not the trivial bar it looks like -- it is exactly "delete iff the');
    console.error('  rule is not load-bearing". This is a RE-DERIVATION of the same count through the');
    console.error('  certificate-issuing path, not a second independent measurement, and is stated');
    console.error('  that way rather than presented as corroboration.');
  } else {
    console.error('verdict: NEGATIVE RESULT -- removing the spatial rule produced ZERO unsound');
    console.error('  auto-merges. The predicate does not need its spatial half under this op model,');
    console.error('  and the KEEP verdict rests only on the count of spatial-only true conflicts');
    console.error('  against a "delete iff zero" threshold. That is a materially weaker position');
    console.error('  than the module docstring claims. Do not bury it.');
  }
  console.error(
    `ablation certificates:   ${ablation.certificatesIssued} issued, ${ablation.certificatesVerified} re-verified (under the ablated predicate), ${ablation.certificateFailures} failures`,
  );
  console.error(`ablation elapsed:        ${(ablation.elapsedMs / 1000).toFixed(1)}s`);
  console.error('---------------------------------------------------------------------');

  /* ---- G4 item 7: what the rule buys, and what the 9 decomposes into -- */

  console.error('');
  console.error('---- WHAT THE SPATIAL RULE BUYS: replay-cost avoidance, priced (G4 item 7) ----');
  console.error('the ablation number above is NOT "the certificate would be unsound without the');
  console.error('rule". createCommutationCertificate replays BOTH orders and refuses on');
  console.error('apply-failed / non-commutative whatever the predicate said, in both modes, so');
  console.error(`zero unsound certificates ship either way (ablated failures: ${ablation.certificateFailures}).`);
  console.error('what the rule buys is that the predicate refuses these schedules BEFORE the');
  console.error('replay, so the expensive exact check never runs on them:');
  console.error('');
  console.error(
    `  replay-cost avoidance on ${spatialOnly.flagged} schedules (the spatial rule fired ALONE), of which` ,
  );
  console.error(
    `    ${spatialOnly.trueConflicts} the replay would have had to catch (${spatialOnly.trueApplyFailed} apply-failed, ${spatialOnly.trueDiverged} diverged), and`,
  );
  console.error(
    `    ${spatialOnly.falseConflicts} the replay would have CERTIFIED -- FALSE REFUSALS, the price paid.`,
  );
  console.error('');
  console.error(
    `THE CONCLUSION, as the artifact supports it: replay-cost avoidance on ${spatialOnly.flagged} schedules`,
  );
  console.error(
    `at the price of ${spatialOnly.falseConflicts} false refusals, with the derived-cut sensitivity below.`,
  );
  console.error('');

  console.error(
    `[g2-merge] sensitivity: re-scoring the same ${SCHEDULES} schedules across the semantics 2x2...`,
  );
  const sensitivity = await runDerivedCutSensitivity({ schedules: SCHEDULES, seed: SEED, epsilonMm: EPSILON_MM });
  const cell = (v) =>
    `${String(v.unsoundAutoMerges).padStart(3)} (apply-failed ${v.unsoundApplyFailed}, diverged ${v.unsoundDiverged})`;
  const m = sensitivity.matched;
  const r = sensitivity.regenerated;
  console.error('');
  console.error(`the ${ablation.unsoundAutoMerges} above is a property of TWO modelling choices in merge-model.ts, and`);
  console.error('neither of them is IFC. IfcRelVoidsElement imposes no containment (this repo\'s own');
  console.error('kernel clips overhanging cutters -- rust/geometry/src/router/voids/), and the cut is');
  console.error('DERIVED at load time from the uncut Body (rust/geometry/src/void_index.rs), never');
  console.error('stored. Re-scored across the 2x2, schedule stream pinned to the baseline so each');
  console.error('cell is an attribution of the SAME events:');
  console.error('');
  const rowLabel = (label) => `  ${label.padEnd(26)}`;
  console.error(`${rowLabel('cuts \\ containment')}enforced                        off`);
  console.error(`${rowLabel('lazy   (B4.2 default)')}${cell(m.lazyEnforced).padEnd(32)}${cell(m.lazyNoContainment)}`);
  console.error(`${rowLabel('derived (IFC + this repo)')}${cell(m.derivedEnforced).padEnd(32)}${cell(m.derivedNoContainment)}`);
  console.error('');
  console.error('  PRECONDITION on the "off" column: the footprint soundness argument in');
  console.error('  merge-model.ts holds only under containment: enforced (it needs an opening to');
  console.error('  lie inside its host, so an opening op\'s region necessarily meets a host op\'s).');
  console.error('  With containment off, openings may overhang and the predicate under-approximates');
  console.error('  by construction, so those two cells measure the OP MODEL under a predicate that');
  console.error('  is not sound for it -- not the shipping predicate, and not the exam bar.');
  console.error('');
  console.error('  regenerating the stream under each variant\'s own semantics instead:');
  console.error(
    `    derived/enforced ${cell(r.derivedEnforced)}   lazy/off ${cell(r.lazyNoContainment)}   derived/off ${cell(r.derivedNoContainment)}`,
  );
  console.error('');
  console.error(
    `HOW TO READ IT: derived cuts alone take ${m.lazyEnforced.unsoundAutoMerges} -> ${m.derivedEnforced.unsoundAutoMerges};` +
      ` dropping containment as well takes it to ${m.derivedNoContainment.unsoundAutoMerges}`,
  );
  console.error(
    `(schedule-matched) or ${r.derivedNoContainment.unsoundAutoMerges} (regenerated).`,
  );
  // The mechanism reading is DERIVED from the cells, not asserted: at other
  // schedule counts or seeds the grid can decompose differently, and a
  // hard-coded sentence would then be a false claim printed by the artifact
  // that refutes it.
  if (m.lazyNoContainment.unsoundAutoMerges >= m.lazyEnforced.unsoundAutoMerges) {
    console.error('The decomposition is NOT a partition: dropping containment ALONE leaves the count');
    console.error(
      `at ${m.lazyNoContainment.unsoundAutoMerges} (apply-failed ${m.lazyNoContainment.unsoundApplyFailed}, diverged ${m.lazyNoContainment.unsoundDiverged}) --` +
        ' the containment rejections simply become divergences of',
    );
    console.error('the stale cut. The stored lazy cut is the dominant mechanism and sustains the whole');
    console.error('count on its own; containment is load-bearing only once the cut is derived.');
  } else {
    console.error(
      `Dropping containment alone takes it to ${m.lazyNoContainment.unsoundAutoMerges}, so at this schedule count and seed the two`,
    );
    console.error('mechanisms do decompose additively. That is NOT what the gate defaults measure --');
    console.error('re-read the grid before quoting either mechanism as independent.');
  }
  console.error('Neither number may be quoted without the other.');
  const survivors = r.derivedNoContainment.unsoundAutoMerges;
  if (survivors > 0) {
    console.error('');
    console.error(
      `${survivors} case${survivors === 1 ? '' : 's'} survive${survivors === 1 ? 's' : ''} every correction` +
        ` (regenerated derived/off, schedule ${survivors === 1 ? 'index' : 'indices'}` +
        ` ${r.derivedNoContainment.unsoundScheduleIndices.join(', ')}).`,
    );
    // The IFC-basis paragraph below is a per-case reading of ONE schedule that
    // was read by hand at the gate defaults. It is not a general property of
    // this cell, so it is printed only when the cell still holds exactly that
    // one case at exactly those parameters -- otherwise the artifact would be
    // asserting a mechanism nobody re-derived.
    if (survivors === 1 && AT_GATE_DEFAULTS) {
      console.error('That one case has an IFC basis: one client adds an');
      console.error('opening hosted in an element the other client removes, so one order applies and');
      console.error('the other cannot. That is IfcRelVoidsElement referential integrity, which IFC DOES');
      console.error("impose, and only the spatial half of the predicate catches it -- the add's");
      console.error('writtenNodes are fresh ids, structurally disjoint from the remove.');
    } else {
      console.error(
        `Mechanism NOT stated: the per-case reading in this artifact was derived by hand for the` +
          ` single survivor at the gate defaults`,
      );
      console.error(
        `(1000 schedules, seed 20260724, epsilon ${DEFAULT_EPSILON_MM}mm). At these parameters the cell holds` +
          ` ${survivors} case${survivors === 1 ? '' : 's'},`,
      );
      console.error('so read the listed schedule indices before attributing any mechanism to them.');
    }
  }
  console.error(`sensitivity elapsed:     ${(sensitivity.elapsedMs / 1000).toFixed(1)}s`);
  console.error('---------------------------------------------------------------------------');
  console.error('');
  console.error(
    `spatial rule verdict:  ${report.spatialRuleContributes ? 'KEEP' : 'DELETE'}` +
      ` -- ${
        report.spatialRuleContributes
          ? `it avoids ${spatialOnly.flagged} replays for ${spatialOnly.falseConflicts} false refusals; the ${ablation.unsoundAutoMerges} pairs the reduced`
          : 'a predicate that never fires truthfully is not a contribution'
      }`,
  );
  if (report.spatialRuleContributes) {
    console.error(
      `                       predicate clears fall to ${m.derivedEnforced.unsoundAutoMerges} under derived cuts, and to ${m.derivedNoContainment.unsoundAutoMerges} (schedule-matched) /` +
        ` ${r.derivedNoContainment.unsoundAutoMerges} (regenerated)\n                       with the containment invariant removed too`,
    );
  }
  console.error('');
  console.error(
    `certificates:          ${report.certificatesIssued} issued, ${report.certificatesVerified} independently verified, ${report.certificateFailures} failures`,
  );
  console.error(`elapsed:               ${(report.elapsedMs / 1000).toFixed(1)}s battery + ${(ablation.elapsedMs / 1000).toFixed(1)}s ablation`);
  console.error(`M4 midterm exam:       ${report.examPass ? 'PASS' : 'FAIL'} (zero unsound auto-merges, zero certificate failures)`);
  console.error(`M4 kill criterion:     ${report.killCriterionPass ? 'PASS' : 'FAIL'} (false-conflict rate < 20%, ratio [1])`);
  console.error('===========================================================');

  // stdout stays a superset of the battery report (same top-level keys as
  // before), with the G4 additions under their own keys so every number the
  // verdict block prints is also emitted as data.
  console.log(
    JSON.stringify({
      ...report,
      ratios: {
        headlineFalseConflictRate: {
          value: report.falseConflictRate,
          numerator: report.falseConflicts,
          denominator: report.groundTruthConvergent,
          denominatorName: 'ground-truth-commuting schedules (autoMerged + falseConflicts)',
          isPlanKillCriterionDenominator: true,
        },
        flaggedPrecisionComplement: {
          value: flaggedRate,
          numerator: report.falseConflicts,
          denominator: report.flaggedConflicts,
          denominatorName: 'flagged schedules',
          isPlanKillCriterionDenominator: false,
        },
        spatialFiredPrecisionComplement: {
          value: report.spatialFiredFalseConflictRate,
          numerator: report.spatialFiredFalseConflicts,
          denominator: report.spatialFiredFlagged,
          denominatorName: 'flagged schedules where the spatial rule fired',
          isPlanKillCriterionDenominator: false,
          wilson95: wilson,
        },
        note:
          'ratios [1] and [2]/[3] have different denominators: [1] is a false-positive rate over ' +
          'commuting schedules, [2] and [3] are precision-complements over flagged schedules. ' +
          "[3]'s like-for-like comparator is [2], not [1] and not the plan's <20% bar.",
        distributionChange: {
          previousValue: preRate,
          previousNumerator: PRE_B42_HEADLINE.falseConflicts,
          previousDenominator: PRE_B42_HEADLINE.groundTruthConvergent,
          previousSource: PRE_B42_HEADLINE.source,
          note:
            'the pre-B4.2 and current headline rates are measured on DIFFERENT generative models ' +
            '(B4.2 added hosted openings to the base model), so the change between them is a ' +
            'distribution change, not an improvement in the predicate.',
        },
      },
      ablation,
      /**
       * G4 item 7. The conclusion the artifact supports, emitted as data so it
       * cannot be paraphrased into something stronger, plus the sensitivity
       * grid that must travel with the ablation's headline.
       */
      whatTheSpatialRuleBuys: {
        replayCostAvoidedSchedules: spatialOnly.flagged,
        ofWhichReplayWouldHaveCaught: spatialOnly.trueConflicts,
        falseRefusals: spatialOnly.falseConflicts,
        buysCertificateSoundness: false,
        certificateSoundnessNote:
          'createCommutationCertificate replays both orders and refuses on apply-failed / ' +
          'non-commutative regardless of the predicate, so zero unsound certificates are ' +
          'emitted with or without the spatial rule. The rule buys replay-cost avoidance, ' +
          'not soundness of the certificate.',
        conclusion:
          `replay-cost avoidance on ${spatialOnly.flagged} schedules at the price of ` +
          `${spatialOnly.falseConflicts} false refusals, with the derived-cut sensitivity ` +
          `(${m.lazyEnforced.unsoundAutoMerges} -> ${m.derivedEnforced.unsoundAutoMerges}, and ` +
          `${m.derivedNoContainment.unsoundAutoMerges} schedule-matched / ` +
          `${r.derivedNoContainment.unsoundAutoMerges} regenerated with the containment invariant removed).`,
      },
      sensitivity,
    }),
  );
  if (!report.examPass || !report.killCriterionPass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
