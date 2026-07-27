/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * merge-battery.ts (Bet B2.1): the M4 midterm property battery at reduced
 * schedule count for CI (the full 1,000-schedule run is the gate script,
 * scripts/moonshot/g2-merge-soundness.mjs). Asserts the exam invariant
 * (zero unsound auto-merges), determinism under a fixed seed, and that the
 * generator actually exercises both sides of the predicate (some schedules
 * merge, some are flagged, and both true and false conflicts occur).
 */

import { describe, expect, it } from 'vitest';
import { buildBaseModel, generateClientOps, mulberry32, runMergeBattery } from '../src/merge-battery.js';
import { applyOps } from '../src/merge-model.js';

/** 400, not 150: under the B4.2 coupled semantics the battery must show the
 *  spatial rule producing TRUE conflicts on its own, and spatial-only true
 *  conflicts are rare enough (~1% of schedules) that 150 can draw zero. The
 *  run is ~1 s, so the extra schedules are free. */
const SCHEDULES = 400;
const SEED = 20260724;

describe('runMergeBattery', () => {
  it(`runs ${SCHEDULES} schedules with zero unsound auto-merges and zero certificate failures (the exam invariant)`, async () => {
    const report = await runMergeBattery({ schedules: SCHEDULES, seed: SEED });
    expect(report.schedules).toBe(SCHEDULES);
    expect(report.unsoundAutoMerges).toBe(0);
    expect(report.unsoundScheduleIndices).toEqual([]);
    expect(report.certificateFailures).toBe(0);
    expect(report.examPass).toBe(true);
    // The generator must exercise both predicate outcomes, or the battery
    // proves nothing.
    expect(report.autoMerged).toBeGreaterThan(0);
    expect(report.flaggedConflicts).toBeGreaterThan(0);
    expect(report.autoMerged + report.flaggedConflicts + report.unsoundAutoMerges).toBe(SCHEDULES);
    // Ground truth splits flagged schedules exhaustively.
    expect(report.trueConflicts + report.falseConflicts).toBe(report.flaggedConflicts);
    // Certificates were issued for auto-merges and a sample was verified.
    expect(report.certificatesIssued).toBe(report.autoMerged);
    expect(report.certificatesVerified).toBeGreaterThan(0);
    // Rates are well-formed.
    expect(report.conflictRate).toBeCloseTo(report.flaggedConflicts / SCHEDULES, 12);
    expect(report.falseConflictRate).toBeGreaterThanOrEqual(0);
    expect(report.falseConflictRate).toBeLessThanOrEqual(1);
  }, 120_000);

  it('decomposes flagged schedules by which rule fired, exhaustively', async () => {
    const report = await runMergeBattery({ schedules: SCHEDULES, seed: SEED, verifyEvery: 0 });
    const { structuralOnly, spatialOnly, both } = report.byRule;
    expect(structuralOnly.flagged + spatialOnly.flagged + both.flagged).toBe(report.flaggedConflicts);
    for (const tally of [structuralOnly, spatialOnly, both]) {
      expect(tally.trueConflicts + tally.falseConflicts).toBe(tally.flagged);
      expect(tally.trueApplyFailed + tally.trueDiverged).toBe(tally.trueConflicts);
    }
    expect(spatialOnly.trueConflicts + both.trueConflicts + structuralOnly.trueConflicts).toBe(report.trueConflicts);
    expect(report.spatialFiredFlagged).toBe(spatialOnly.flagged + both.flagged);
    expect(report.spatialFiredFalseConflictRate).toBeCloseTo(
      report.spatialFiredFalseConflicts / report.spatialFiredFlagged,
      12,
    );
  }, 120_000);

  it('the SPATIAL rule produces true conflicts on its own (the B4.2 finding, closed)', async () => {
    // The G2 red-team review measured 0 spatial-only true conflicts in 1,000
    // schedules: under the v0 per-node op model the spatial half of the
    // predicate could not be right about anything. Under the coupled
    // semantics it can be, and is -- both by rejection (an order that fails
    // to apply) and by divergence (a stale void cut). A regression to zero
    // here means the coupling has been lost and the rule is unfalsifiable
    // again, which per the plan's pre-committed consequence means deleting
    // it.
    const report = await runMergeBattery({ schedules: SCHEDULES, seed: SEED, verifyEvery: 0 });
    expect(report.spatialOnlyTrueConflicts).toBeGreaterThan(0);
    expect(report.spatialRuleContributes).toBe(true);
    const spatial = report.byRule.spatialOnly;
    expect(spatial.trueDiverged).toBeGreaterThan(0);
    expect(report.byRule.both.trueApplyFailed).toBeGreaterThan(0);
  }, 120_000);

  it('is deterministic: the same seed reproduces the same counts', async () => {
    const first = await runMergeBattery({ schedules: 40, seed: 7, verifyEvery: 0 });
    const second = await runMergeBattery({ schedules: 40, seed: 7, verifyEvery: 0 });
    const strip = ({ elapsedMs: _elapsed, ...rest }: Awaited<ReturnType<typeof runMergeBattery>>) => rest;
    expect(strip(second)).toEqual(strip(first));
  }, 120_000);

  it('different seeds produce different op schedules (the PRNG is actually wired in)', () => {
    const rngA = mulberry32(1);
    const rngB = mulberry32(2);
    const baseA = buildBaseModel(rngA);
    const baseB = buildBaseModel(rngB);
    const opsA = generateClientOps(baseA, { client: 'a', scheduleIndex: 0, rng: rngA });
    const opsB = generateClientOps(baseB, { client: 'a', scheduleIndex: 0, rng: rngB });
    expect(JSON.stringify(opsA)).not.toBe(JSON.stringify(opsB));
  });
});

describe('generateClientOps', () => {
  it('always emits a self-consistent sequence the client can apply to its own replica', () => {
    const rng = mulberry32(42);
    for (let s = 0; s < 200; s++) {
      const base = buildBaseModel(rng);
      const ops = generateClientOps(base, { client: 'a', scheduleIndex: s, rng });
      expect(ops.length).toBeGreaterThan(0);
      // Must not throw: a client's own op set is sequentially valid.
      applyOps(base, ops);
    }
  });
});
