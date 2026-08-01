#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B3.5 -- the integrated compounding demo (Phase 3 of
 * docs/vision/moonshots-execution-plan.md): one narrative run chaining the
 * proven moonshot pieces so each amplifies the next.
 *
 *   ACT 1  BIRTH        world-gym births a seeded building; the reward
 *                       channels score it (M2).
 *   ACT 2  PROOF        its provenance DAG + a certificate, verified in a
 *                       second process; a tampered copy is refused (M1/G0).
 *   ACT 3  SABOTAGE     a sibling seed is corrupted with planted defects;
 *                       the benchmark scorer's oracle path scores the hunt
 *                       (M2/B2.2).
 *   ACT 4  CONVERGENCE  two clients edit the proven model concurrently;
 *                       certified auto-merge + correctly blocked conflict +
 *                       the G2 property battery (M4/B2.1).
 *   ACT 5  DESCENT      shortened differentiable carbon optimization,
 *                       kernel-validated optimum (M3).
 *
 * Usage:  node scripts/moonshot/b35-demo/run.mjs
 * Env:    B35_SEED (default 20260724), B35_OUT_DIR (artifact dir, default
 *         $TMPDIR/ifc-lite-b35-demo), B35_DEV_SLICE (act-3 dev seeds,
 *         default 40), B35_BATTERY (act-4 schedules, default 1000 -- the
 *         M4 midterm count).
 *
 * Outputs demo-report.md + demo-report.json next to this script. Everything
 * under `deterministic` in the JSON is a pure function of the seeds; wall
 * clocks and the timestamp live ONLY under `volatile`.
 *
 * Resilience: every act runs in its own try/catch. A failed act is reported
 * by name with its error; dependent acts are skipped with a reason; the
 * remaining acts still run; the exit code is 1 if anything failed.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HERE, MASTER_SEED, OUT_DIR, banner, say, timed } from './util.mjs';
import { runAct1 } from './act1-birth.mjs';
import { runAct2 } from './act2-proof.mjs';
import { runAct3 } from './act3-sabotage.mjs';
import { runAct4 } from './act4-convergence.mjs';
import { runAct5 } from './act5-descent.mjs';

const DEV_SLICE = Number(process.env.B35_DEV_SLICE ?? 40);
const BATTERY_SCHEDULES = Number(process.env.B35_BATTERY ?? 1000);
if (!Number.isInteger(DEV_SLICE) || DEV_SLICE < 1) {
  throw new Error(`B35_DEV_SLICE must be a positive integer, got ${JSON.stringify(process.env.B35_DEV_SLICE)}`);
}
if (!Number.isInteger(BATTERY_SCHEDULES) || BATTERY_SCHEDULES < 1) {
  throw new Error(`B35_BATTERY must be a positive integer, got ${JSON.stringify(process.env.B35_BATTERY)}`);
}

async function main() {
  const t0 = performance.now();
  say('##########################################################################');
  say('#  ifc-lite B3.5 -- THE INTEGRATED COMPOUNDING DEMO                      #');
  say('#  neural proposes, kernel disposes: five moonshots, one storyline       #');
  say('##########################################################################');
  say(`  master seed: ${MASTER_SEED}   artifacts: ${OUT_DIR}`);

  const acts = {};       // actKey -> { status, headline?, deterministic?, error?, reason? }
  const volatile = {};   // actKey -> volatile numbers (timings etc.)
  const timings = {};    // actKey -> wall ms
  const ctx = {};        // cross-act handoff (the act-1 model)

  async function runAct(key, title, fn, { dependsOn } = {}) {
    if (dependsOn && acts[dependsOn]?.status !== 'ok') {
      const reason = `depends on ${dependsOn}, which ${acts[dependsOn] ? acts[dependsOn].status : 'did not run'}`;
      acts[key] = { status: 'skipped', reason };
      say('');
      say(`  !! ${title} SKIPPED: ${reason}`);
      return;
    }
    try {
      const { result, ms } = await timed(fn);
      timings[key] = ms;
      acts[key] = { status: 'ok', deterministic: result.deterministic };
      if (result.volatile) volatile[key] = result.volatile;
      if (result.model) ctx.model = result.model;
    } catch (err) {
      timings[key] = timings[key] ?? null;
      acts[key] = { status: 'failed', error: String(err?.message ?? err) };
      say('');
      say(`  !! ${title} FAILED: ${acts[key].error}`);
      if (err?.stack) process.stderr.write(`${err.stack}\n`);
    }
  }

  await runAct('act1', 'ACT 1 (BIRTH)', () => runAct1({ seed: MASTER_SEED }));
  await runAct('act2', 'ACT 2 (PROOF)', () => runAct2({ model: ctx.model }), { dependsOn: 'act1' });
  await runAct('act3', 'ACT 3 (SABOTAGE + DETECTION)', () => runAct3({ seed: MASTER_SEED, devSliceSize: DEV_SLICE }));
  await runAct('act4', 'ACT 4 (CONVERGENCE)', () => runAct4({ model: ctx.model, batterySchedules: BATTERY_SCHEDULES, seed: MASTER_SEED }), { dependsOn: 'act1' });
  await runAct('act5', 'ACT 5 (DESCENT)', () => runAct5({ seed: MASTER_SEED }));

  const totalMs = Math.round(performance.now() - t0);

  // ---------------- FINALE ----------------
  banner('FINALE', 'THE LEDGER', 'every number below is reproducible from the master seed');
  const statusLine = (k, label) => {
    const a = acts[k];
    const t = timings[k] != null ? `${(timings[k] / 1000).toFixed(1)}s` : '-';
    say(`  ${label.padEnd(26)} ${String(a.status).toUpperCase().padEnd(8)} ${t.padStart(7)}  ${a.error ?? a.reason ?? headlineOf(k, a) ?? ''}`);
  };
  statusLine('act1', 'Act 1 BIRTH');
  statusLine('act2', 'Act 2 PROOF');
  statusLine('act3', 'Act 3 SABOTAGE');
  statusLine('act4', 'Act 4 CONVERGENCE');
  statusLine('act5', 'Act 5 DESCENT');
  say(`  ${'TOTAL WALL CLOCK'.padEnd(26)} ${''.padEnd(8)} ${(totalMs / 1000).toFixed(1)}s`);

  const failed = Object.entries(acts).filter(([, a]) => a.status === 'failed');
  const skipped = Object.entries(acts).filter(([, a]) => a.status === 'skipped');
  if (failed.length > 0) {
    say('');
    for (const [k, a] of failed) say(`  FAILED: ${k} -- ${a.error}`);
    for (const [k, a] of skipped) say(`  SKIPPED: ${k} -- ${a.reason}`);
  }

  // ---------------- REPORT ----------------
  const report = {
    demo: 'b35-integrated-compounding-demo',
    reportVersion: '1.0.0',
    command: 'node scripts/moonshot/b35-demo/run.mjs',
    deterministic: {
      masterSeed: MASTER_SEED,
      config: { devSliceSize: DEV_SLICE, batterySchedules: BATTERY_SCHEDULES },
      acts: Object.fromEntries(Object.entries(acts).map(([k, a]) => [k, {
        status: a.status,
        ...(a.error ? { error: a.error } : {}),
        ...(a.reason ? { reason: a.reason } : {}),
        ...(a.deterministic ? { data: a.deterministic } : {}),
      }])),
    },
    volatile: {
      note: 'ONLY this block differs between runs: wall clocks and the timestamp. Everything under `deterministic` is a pure function of the master seed.',
      generatedAt: new Date().toISOString(),
      nodeVersion: process.version,
      totalWallClockMs: totalMs,
      actWallClockMs: timings,
      actVolatile: volatile,
      artifactDir: OUT_DIR,
    },
  };

  const jsonPath = path.join(HERE, 'demo-report.json');
  const mdPath = path.join(HERE, 'demo-report.md');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  await writeFile(mdPath, renderMarkdown(report), 'utf-8');
  say('');
  say(`  report: ${path.relative(process.cwd(), mdPath)} + demo-report.json`);

  process.exitCode = failed.length > 0 ? 1 : 0;
}

function headlineOf(key, act) {
  if (act.status !== 'ok') return null;
  const d = act.deterministic;
  switch (key) {
    case 'act1':
      return `${d.entityCount} entities, 5/5 reward channels ${d.allChannelsPerfect ? '= 1.0' : 'NOT perfect'}`;
    case 'act2':
      return `verified reading ${d.nodesResolvedPct}% of ${d.totalNodes} nodes; tamper caught=${d.tamper.caught}`;
    case 'act3':
      return `spotlight ${d.spotlight.caughtCount}/${d.spotlight.plantedCount} caught; macro-F1 ${d.oracleSlice.defectMacroF1}`;
    case 'act4':
      return `${d.battery.autoMerged}/${d.battery.schedules} auto-merged, ${d.battery.unsoundAutoMerges} unsound; conflict blocked=${d.blockedConflict.blocked}`;
    case 'act5':
      return `carbon -${d.reductionPct.toFixed(1)}%, kernel rel dev ${d.kernelValidation.carbonRelDev}`;
    default:
      return null;
  }
}

function renderMarkdown(report) {
  const { deterministic: det, volatile: vol } = report;
  const a = (k) => det.acts[k] ?? { status: 'missing' };
  const d = (k) => a(k).data ?? {};
  const lines = [];
  const push = (...ls) => lines.push(...ls);

  push('# B3.5 integrated compounding demo -- report');
  push('');
  push('One command, five moonshots, one storyline: `node scripts/moonshot/b35-demo/run.mjs`.');
  push('');
  push(`Master seed: **${det.masterSeed}**. Every number in this report except the`);
  push('clearly marked *Volatile* section at the bottom is a pure function of that');
  push('seed: rerun the command and the hashes, scores and counts reproduce exactly.');
  push('');
  push('| Act | Story | Status | Headline |');
  push('|-----|-------|--------|----------|');
  const row = (k, name, story) => {
    const act = a(k);
    const head = act.status === 'ok' ? headlineOf(k, { status: 'ok', deterministic: act.data }) : (act.error ?? act.reason ?? '-');
    push(`| ${name} | ${story} | ${act.status} | ${head} |`);
  };
  row('act1', '1 BIRTH', 'world-gym births a seeded building; reward channels score it');
  row('act2', '2 PROOF', 'provenance certificate verified in a second process; tamper refused');
  row('act3', '3 SABOTAGE', 'planted defects hunted; benchmark oracle scores the detector');
  row('act4', '4 CONVERGENCE', 'certified auto-merge + blocked conflict + property battery');
  row('act5', '5 DESCENT', 'differentiable carbon descent, kernel-validated optimum');
  push('');

  if (a('act1').status === 'ok') {
    const x = d('act1');
    push('## Act 1 -- BIRTH (M2 world-gym)');
    push('');
    push(`Seed ${x.seed} deterministically births ${x.family === 'office' ? 'an' : 'a'} **${x.family}** building: ${x.entityCount}`);
    push(`entities, ${x.storeyCount} storey(s), ${x.fileSize} bytes.`);
    push('');
    push(`- model sha256: \`${x.sha256}\` (regenerable from the seed alone)`);
    push(`- schema: valid=${x.schema.valid} (${x.schema.errors} errors, ${x.schema.warnings} warnings); clashes: ${x.clashTotal}`);
    push(`- ground-truth totals (m3 / m2): ${Object.entries(x.groundTruthTotals).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    push('- reward channels: ' + Object.entries(x.rewardChannels).map(([k, v]) => `${k}=${v ?? 'n/a'}`).join(', '));
    push('');
  }

  if (a('act2').status === 'ok') {
    const x = d('act2');
    push('## Act 2 -- PROOF (M1 proof-carrying edit, the G0 story on a fresh model)');
    push('');
    push(`The parsed building becomes a ${x.totalNodes}-node node-hash-v0 DAG`);
    push(`(${x.elements} elements, ${x.psetLeaves} pset/qset leaves, ${x.storeys} storey element(s),`);
    push(`${x.storeys} storey containment relationship(s), 1 root).`);
    push(`One edit -- ${x.edit.ifcType} #${x.edit.expressId} ${x.edit.property}: ${JSON.stringify(x.edit.before)} -> ${JSON.stringify(x.edit.after)} --`);
    push('yields a certificate carrying the changed path, the untouched sibling reads and a');
    push(`subtree-untouched claim over ${x.untouchedClaimRefs} untouched ${x.claimGranularity === 'storey-subtrees' ? 'storey subtree(s)' : 'sibling element subtree(s)'}.`);
    push('');
    push(`- root hash before: \`${x.rootHashBefore}\``);
    push(`- root hash after:  \`${x.rootHashAfter}\``);
    push(`- second-process verification: ok=${x.secondProcessVerifyOk}, resolving ${x.nodesResolved}/${x.totalNodes} nodes (${x.nodesResolvedPct}%)`);
    if (x.claimGranularity === 'sibling-element-subtrees') {
      push('  (single-storey building, so the claim is per sibling element; on multi-storey models the claim');
      push('  coarsens to whole storey subtrees and the verifier reads under 5% of the DAG -- the G0 gate shape)');
    }
    push(`- tampered copy (silent ${x.tamper.ifcType} #${x.tamper.expressId} mutation inside claimed-untouched territory): caught=${x.tamper.caught}, reason: \`${x.tamper.reason}\``);
    push('');
  }

  if (a('act3').status === 'ok') {
    const x = d('act3');
    push('## Act 3 -- SABOTAGE + DETECTION (M2 corruption layer + B2.2 benchmark oracle)');
    push('');
    push(`Sibling seed ${x.spotlight.seed} was force-corrupted; the corruption layer recorded`);
    push(`${x.spotlight.plantedCount} defect type(s) at plant time (ground truth by construction):`);
    push('');
    for (const def of x.spotlight.plantedDefects) push(`- planted: \`${JSON.stringify(def)}\``);
    push('');
    push(`The real check pipeline detected: ${x.spotlight.detectedTypes.join(', ') || '(nothing)'} -- **${x.spotlight.caughtCount}/${x.spotlight.plantedCount} caught**.`);
    push('');
    push(`The same detector, scored by the benchmark's own oracle over the first ${x.oracleSlice.seeds.length}`);
    push(`official dev-split seeds (${x.oracleSlice.corruptedCount} corrupted; truth regenerated from seeds, no stored key):`);
    push('');
    push(`- defect-detection macro-F1: **${x.oracleSlice.defectMacroF1}**`);
    push(`- quantity-estimation score: **${x.oracleSlice.quantityScore}**`);
    push(`- validity-triage score: **${x.oracleSlice.triageScore}** over ${x.oracleSlice.triagePairs} cross-severity pairs (0.5 = uninformative)`);
    push(`- known blind spot, honestly priced in: \`dangling-ref\` is invisible to \`ifc-lite validate\` (per-type F1 ${x.oracleSlice.defectPerType?.['dangling-ref']?.f1 ?? 'n/a'})`);
    push('');
  }

  if (a('act4').status === 'ok') {
    const x = d('act4');
    push('## Act 4 -- CONVERGENCE (M4/B2.1 commutation certificates)');
    push('');
    push(`The proven act-1 building (${x.baseEntities} entities) becomes the shared base state,`);
    push(`Merkle root \`${x.baseRootHash}\`.`);
    push('');
    push('- disjoint concurrent edits (alice: wall FireRating, bob: other element Status):');
    push(`  certificate issued, both orders replay to merged root \`${x.mergedRootHash}\`;`);
    push(`  independent re-verification: ok=${x.autoMerge.verifiedIndependently}`);
    push(`- colliding edits (both write the same wall pset): blocked=${x.blockedConflict.blocked}, ${x.blockedConflict.conflicts.length} conflicting cross pair(s) -- no certificate, no silent overwrite`);
    push(`- property battery (${x.battery.schedules} schedules, seed ${det.masterSeed}): ${x.battery.autoMerged} auto-merged,`);
    push(`  **${x.battery.unsoundAutoMerges} unsound auto-merges**, ${x.battery.flaggedConflicts} flagged (${(x.battery.conflictRate * 100).toFixed(2)}%),`);
    // The denominator is spelled out on purpose (G4 red-team review item 5):
    // this rate is `falseConflicts / ground-truth-COMMUTING schedules`, and
    // the previous line's flagged count is a DIFFERENT denominator sitting
    // right next to it. The bare percentage invited exactly that misreading.
    push(`  false-conflict rate ${(x.battery.falseConflictRate * 100).toFixed(2)}% = ${x.battery.falseConflicts} false / ${x.battery.groundTruthConvergent} ground-truth-COMMUTING`);
    push(`  schedules (the denominator the plan's < 20% kill criterion is defined over -- not the ${x.battery.flaggedConflicts} flagged),`);
    push(`  certificates ${x.battery.certificatesIssued} issued / ${x.battery.certificatesVerified} verified / ${x.battery.certificateFailures} failures;`);
    push(`  exam ${x.battery.examPass ? 'PASS' : 'FAIL'}, kill criterion ${x.battery.killCriterionPass ? 'PASS' : 'FAIL'}`);
    push('  (the full decomposition, the spatial-restricted rate with its Wilson interval and the');
    push('  spatial-rule ablation live in `scripts/moonshot/g2-merge-soundness.mjs`, which runs the');
    push('  same battery at gate scale)');
    push('');
  }

  if (a('act5').status === 'ok') {
    const x = d('act5');
    push('## Act 5 -- DESCENT (M3 differentiable carbon, kernel-validated)');
    push('');
    push(`Shortened penalty descent (${x.penaltyRounds.length} rounds) over the diff-spike's 24-parameter`);
    push('differentiable building with exact dual-number gradients:');
    push('');
    push(`- carbon: ${x.startCarbonKg} -> **${x.optimumCarbonKg} kgCO2e** (-${x.reductionPct}%); residual scaled constraint slack ${x.residualScaledViolation} across ${x.residualConstraints.length} constraint(s) (the full spike run drives this below 1e-6)`);
    push(`- optimum authored as IFC: ${x.optimumIfc.bytes} bytes, ${x.optimumIfc.mappedElements} mapped elements, sha256 \`${x.optimumIfc.sha256}\``);
    push(`- kernel re-meshed every element: worst volume rel dev ${x.kernelValidation.worstElementRelDev} (${x.kernelValidation.worstElementKey}), missing meshes ${x.kernelValidation.missingMeshes}`);
    push(`- kernel-derived carbon ${x.kernelValidation.kernelCarbonKg} kgCO2e, rel dev ${x.kernelValidation.carbonRelDev} vs the parametric claim`);
    push(`- schema check on the optimum bytes: valid=${x.schema.valid} (${x.schema.errors} errors, ${x.schema.warnings} warnings)`);
    push('');
  }

  for (const [k, act] of Object.entries(det.acts)) {
    if (act.status === 'failed') push(`## ${k} FAILED\n\n\`${act.error}\`\n`);
    if (act.status === 'skipped') push(`## ${k} skipped\n\n${act.reason}\n`);
  }

  push('## Volatile (the ONLY non-deterministic block)');
  push('');
  push('Wall clocks and the timestamp below change run to run; nothing above does.');
  push('');
  push(`- generated at: ${vol.generatedAt} (node ${vol.nodeVersion})`);
  push(`- total wall clock: ${(vol.totalWallClockMs / 1000).toFixed(1)}s`);
  push(`- per act: ${Object.entries(vol.actWallClockMs).map(([k, v]) => `${k}=${v == null ? '-' : `${(v / 1000).toFixed(1)}s`}`).join(', ')}`);
  push(`- artifacts (outside the repo): ${vol.artifactDir}`);
  push('');
  return `${lines.join('\n')}\n`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
