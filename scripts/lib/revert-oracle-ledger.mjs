/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ASSERTION_FAILURE,
  BASELINE_BROKEN,
  PASS,
  OBSERVED,
  UNOBSERVED,
  INCONCLUSIVE,
} from './revert-oracle.mjs';

const completePass = (run) => run?.kind === PASS && run.attributed === true
  && run.exitCode === 0 && run.signal === null && Number.isInteger(run.total) && run.total > 0;
const assertionWitness = (baseline, reverted) =>
  completePass(baseline) &&
  reverted?.kind === ASSERTION_FAILURE &&
  reverted.attributed === true &&
  Number.isInteger(reverted.exitCode) && reverted.exitCode !== 0 && reverted.signal === null &&
  Number.isInteger(reverted.total) &&
  reverted.total >= baseline.total &&
  Number.isInteger(reverted.failed) &&
  reverted.failed > 0;

/** Convert planning failures into ledger gaps without abandoning valid runs. */
export function partitionRunnablePlans(plans, unassigned = []) {
  const gaps = unassigned.map((gap) => typeof gap === 'string'
    ? { file: gap, reason: 'could not find an owning package' }
    : gap);
  for (const plan of plans.filter((candidate) => !candidate.runner)) {
    gaps.push({ file: plan.file, reason: `no runner derived; scripts.test = ${JSON.stringify(plan.script)}` });
  }
  return { runnable: plans.filter((plan) => plan.runner), gaps };
}

/** Join the baseline and reverted measurements to the exact changed file/run. */
export function buildExecutionLedger({ plans, gaps = [], support = [], baselineResults, revertedResults }) {
  const measurement = (run, plan) => run ? {
    kind: run.kind,
    passed: run.passed ?? null,
    failed: run.failed ?? null,
    total: run.total ?? null,
    exitCode: run.rawExitCode ?? null,
    signal: run.signal ?? null,
    toolchain: run.toolchain ?? null,
    attributed: run.attributed === true,
    files: run.attributed === true ? [plan.file] : [],
    testIdentities: [...new Set(run.identities ?? [])],
    evidence: run.evidence ?? [],
  } : null;
  const entries = plans.map((plan, index) => ({
    file: plan.file,
    role: 'executable',
    runKey: plan.key,
    adapter: plan.adapter ?? (plan.typecheck ? 'typescript' : null),
    runner: plan.runner ? {
      family: plan.runner.family,
      command: [plan.runner.bin, ...plan.runner.args],
    } : null,
    features: plan.features ?? [],
    attribution: plan.typecheck ? 'compiler-program-membership' : plan.moduleFilter ? 'cargo-module-filter' : plan.crate ? 'cargo-integration-target' : 'exact-file-argument',
    baseline: measurement(baselineResults[index], plan),
    reverted: measurement(revertedResults[index], plan),
  }));
  for (const gap of gaps) entries.push({ file: gap.file, role: 'capability-gap', reason: gap.reason });
  for (const file of support) entries.push({ file, role: 'support', reason: 'test support/fixture; executed through an entrypoint, not independently attributable' });
  return entries;
}

/**
 * Judge exact-file evidence asymmetrically: one valid witness is sufficient,
 * while UNOBSERVED requires complete pass/pass evidence for every executable.
 */
export function ledgerVerdict(ledger) {
  const runs = ledger.filter((entry) => entry.role === 'executable');
  const witness = runs.find((entry) => assertionWitness(entry.baseline, entry.reverted));
  if (witness) {
    return {
      verdict: OBSERVED,
      exitCode: 0,
      reason: `reverting production turned an assertion RED in ${witness.file}; that file has a green, attributable baseline.`,
      witness: { file: witness.file, runKey: witness.runKey },
    };
  }

  const broken = runs.find((entry) => entry.baseline && !completePass(entry.baseline));
  if (broken) {
    return {
      verdict: BASELINE_BROKEN,
      exitCode: 3,
      reason: `${broken.file} has no green attributable baseline (${broken.baseline.kind}${broken.baseline.evidence?.[0] ? `: ${broken.baseline.evidence[0]}` : ''}).`,
    };
  }

  const gap = ledger.find((entry) => entry.role === 'capability-gap') ??
    runs.find((entry) => !completePass(entry.baseline) || !completePass(entry.reverted));
  if (gap) {
    const detail = gap.reason ?? `${gap.file} produced incomplete reverted evidence (${gap.reverted?.kind ?? 'missing'}).`;
    return { verdict: INCONCLUSIVE, exitCode: 3, reason: `the oracle has an attribution gap: ${detail}` };
  }

  if (runs.length === 0) {
    return { verdict: INCONCLUSIVE, exitCode: 3, reason: 'no changed executable test file was measured.' };
  }
  const changedCollection = runs.find((entry) => entry.baseline.total !== entry.reverted.total
    || (entry.baseline.testIdentities.length > 0 && entry.reverted.testIdentities.length > 0
      && JSON.stringify(entry.baseline.testIdentities) !== JSON.stringify(entry.reverted.testIdentities)));
  if (changedCollection) {
    return {
      verdict: INCONCLUSIVE,
      exitCode: 3,
      reason: `${changedCollection.file} did not execute the same test collection before and after the revert.`,
    };
  }
  return {
    verdict: UNOBSERVED,
    exitCode: 1,
    reason: `all ${new Set(runs.map((entry) => entry.file)).size} changed executable test file(s) passed before and after the revert.`,
  };
}
