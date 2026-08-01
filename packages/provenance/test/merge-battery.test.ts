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
import {
  buildBaseModel,
  generateClientOps,
  mulberry32,
  runDerivedCutSensitivity,
  runMergeBattery,
  runSpatialAblation,
  wilsonInterval,
  Z_95,
} from '../src/merge-battery.js';
import { applyOps, DEFAULT_MERGE_SEMANTICS, type MergeSemantics } from '../src/merge-model.js';

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

/* ------------------------------------------------------------------ */
/* The ablation (G4 red-team review item 6)                              */
/* ------------------------------------------------------------------ */

describe('runSpatialAblation: the same schedules with the spatial rule DISABLED', () => {
  it('produces UNSOUND auto-merges -- the spatial rule is load-bearing for soundness', async () => {
    // The decisive experiment the G4 review asked for. If this ever reads 0,
    // the soundness argument in merge-model.ts's docstring does not need the
    // spatial rule under this op model, and the KEEP verdict rests only on the
    // "delete iff zero spatial-only true conflicts" threshold -- a materially
    // weaker position. A 0 here is a REAL RESULT to report, not a test to
    // relax: it would mean this expectation, and the docstring's claim, are
    // the things that were wrong.
    const ablation = await runSpatialAblation({ schedules: SCHEDULES, seed: SEED, verifyEvery: 0 });
    expect(ablation.unsoundAutoMerges).toBeGreaterThan(0);
    expect(ablation.spatialRuleIsLoadBearing).toBe(true);
    // Both failure modes of the coupling show up: a containment rejection in
    // one order, and a stale lazy cut that diverges.
    expect(ablation.unsoundApplyFailed).toBeGreaterThan(0);
    expect(ablation.unsoundDiverged).toBeGreaterThan(0);
    expect(ablation.unsoundApplyFailed + ablation.unsoundDiverged).toBe(ablation.unsoundAutoMerges);
    expect(ablation.unsoundScheduleIndices).toHaveLength(ablation.unsoundAutoMerges);
    // Exhaustive: every schedule lands in exactly one bucket.
    expect(ablation.autoMerged + ablation.flaggedConflicts + ablation.unsoundAutoMerges).toBe(SCHEDULES);
    expect(ablation.spatialRule).toBe('disabled');
  }, 120_000);

  it('every unsound merge it produces is one the SHIPPING predicate refuses', async () => {
    // The cross-check that runs in the opposite direction to the main
    // battery's `unsoundAutoMerges === 0`: if the full predicate missed even
    // one of these, it would be unsound too.
    const ablation = await runSpatialAblation({ schedules: SCHEDULES, seed: SEED, verifyEvery: 0 });
    expect(ablation.unsoundCaughtBySpatialRule).toBe(ablation.unsoundAutoMerges);
    expect(ablation.spatialRuleCatchesAll).toBe(true);
  }, 120_000);

  it('the ablation count IS the spatial-only true-conflict count (the identity, by construction)', async () => {
    // A schedule that only the spatial rule flags has no structurally
    // conflicting cross pair at all, so the ablated predicate certifies it;
    // if its ground truth is "does not commute", the predicate was wrong in
    // the unsafe direction. Hence: ablated unsound == spatialOnlyTrueConflicts.
    // This is why the plan's "delete iff zero" threshold is not the trivial
    // bar it looks like -- it is exactly "delete iff the rule is not
    // load-bearing for soundness". Pinned so nobody can later present the
    // ablation as an INDEPENDENT corroborating measurement: it is a
    // re-derivation of the same count through the certificate-issuing path.
    const [battery, ablation] = await Promise.all([
      runMergeBattery({ schedules: SCHEDULES, seed: SEED, verifyEvery: 0 }),
      runSpatialAblation({ schedules: SCHEDULES, seed: SEED, verifyEvery: 0 }),
    ]);
    expect(ablation.unsoundAutoMerges).toBe(battery.spatialOnlyTrueConflicts);
  }, 120_000);

  it('sees exactly the schedules the battery sees (one variable changed, not two)', async () => {
    // The generator reads only the seeded PRNG and the op model, never the
    // predicate -- so switching the rule off must move schedules between
    // buckets and never create or destroy one. Turning the rule off can only
    // un-flag the schedules where it fired ALONE: those become auto-merges if
    // they commute and unsound ones if they do not.
    const [battery, ablation] = await Promise.all([
      runMergeBattery({ schedules: SCHEDULES, seed: SEED, verifyEvery: 0 }),
      runSpatialAblation({ schedules: SCHEDULES, seed: SEED, verifyEvery: 0 }),
    ]);
    const spatialOnly = battery.byRule.spatialOnly;
    expect(ablation.flaggedConflicts).toBe(battery.flaggedConflicts - spatialOnly.flagged);
    expect(ablation.autoMerged).toBe(battery.autoMerged + spatialOnly.falseConflicts);
    expect(ablation.unsoundAutoMerges).toBe(spatialOnly.trueConflicts);
  }, 120_000);

  it('is deterministic under a fixed seed', async () => {
    const first = await runSpatialAblation({ schedules: 40, seed: 7, verifyEvery: 0 });
    const second = await runSpatialAblation({ schedules: 40, seed: 7, verifyEvery: 0 });
    const strip = ({ elapsedMs: _elapsed, ...rest }: Awaited<ReturnType<typeof runSpatialAblation>>) => rest;
    expect(strip(second)).toEqual(strip(first));
  }, 120_000);

  it('certificates it issues re-verify under the same ablated predicate', async () => {
    const ablation = await runSpatialAblation({ schedules: 100, seed: SEED });
    expect(ablation.certificatesVerified).toBeGreaterThan(0);
    expect(ablation.certificateFailures).toBe(0);
  }, 120_000);
});

/* ------------------------------------------------------------------ */
/* Derived-cut sensitivity (G4 item 7)                                   */
/* ------------------------------------------------------------------ */

/** The gate defaults. The sensitivity grid is pinned at exactly these,
 *  because the numbers it produces are the ones quoted in prose. */
const GATE_SCHEDULES = 1000;

describe('what the spatial rule buys, and what the ablation count decomposes into', () => {
  it('the rule does NOT buy soundness of the certificate -- the replay backstop does', async () => {
    // The load-bearing correction. "Zero unsound auto-merges" survives
    // deleting the spatial rule entirely, because createCommutationCertificate
    // replays both orders and refuses whatever the predicate said. If this
    // ever fails, the restatement in the module docstring is wrong and the
    // stronger claim it replaced was right.
    const ablation = await runSpatialAblation({ schedules: SCHEDULES, seed: SEED });
    expect(ablation.certificatesIssued).toBeGreaterThan(0);
    expect(ablation.certificateFailures).toBe(0);
  }, 180_000);

  it('the full predicate stays sound under every one of the four semantics', async () => {
    // Same point from the other side: the certificate is protected by replay,
    // not by the op model, so no choice of coupling can make the SHIPPING
    // path emit an unsound merge.
    for (const semantics of [
      { cuts: 'lazy', containment: 'enforced' },
      { cuts: 'derived', containment: 'enforced' },
      { cuts: 'lazy', containment: 'off' },
      { cuts: 'derived', containment: 'off' },
    ] as const satisfies readonly MergeSemantics[]) {
      const report = await runMergeBattery({
        schedules: SCHEDULES,
        seed: SEED,
        verifyEvery: 25,
        semantics,
        generatorSemantics: semantics,
      });
      expect({ semantics, unsound: report.unsoundAutoMerges, failures: report.certificateFailures }).toEqual({
        semantics,
        unsound: 0,
        failures: 0,
      });
    }
  }, 300_000);

  it('prices the rule: replay-cost avoidance on 28 schedules for 19 false refusals (gate defaults)', async () => {
    // The restated conclusion, pinned to the artifact that produces it. These
    // are `byRule.spatialOnly` -- schedules the SPATIAL rule refused alone, so
    // the replay never ran on them: 9 it would have had to catch, 19 it would
    // have certified.
    const report = await runMergeBattery({ schedules: GATE_SCHEDULES, seed: SEED, verifyEvery: 0 });
    const spatialOnly = report.byRule.spatialOnly;
    expect(spatialOnly.flagged).toBe(28);
    expect(spatialOnly.falseConflicts).toBe(19);
    expect(spatialOnly.trueConflicts).toBe(9);
    expect(spatialOnly.falseConflicts + spatialOnly.trueConflicts).toBe(spatialOnly.flagged);
  }, 180_000);

  it('reproduces the sensitivity grid to the digit (gate defaults, seed 20260724)', async () => {
    // THE pin. The G4 reviewers claimed 9 -> 3 -> 1; measured here:
    //   9 -> 3 holds exactly, by both methods.
    //   3 -> 1 is 3 -> 0 schedule-matched, 3 -> 1 regenerated.
    // And their mechanism split ("3 from containment, 6 from the lazy cut")
    // is NOT a partition: containment off ALONE still reads 9, because the
    // three rejections become three divergences of the stale cut.
    const s = await runDerivedCutSensitivity({ schedules: GATE_SCHEDULES, seed: SEED });
    const cell = (v: { unsoundAutoMerges: number; unsoundApplyFailed: number; unsoundDiverged: number }) => [
      v.unsoundAutoMerges,
      v.unsoundApplyFailed,
      v.unsoundDiverged,
    ];
    expect({
      matchedLazyEnforced: cell(s.matched.lazyEnforced),
      matchedDerivedEnforced: cell(s.matched.derivedEnforced),
      matchedLazyNoContainment: cell(s.matched.lazyNoContainment),
      matchedDerivedNoContainment: cell(s.matched.derivedNoContainment),
      regeneratedDerivedEnforced: cell(s.regenerated.derivedEnforced),
      regeneratedLazyNoContainment: cell(s.regenerated.lazyNoContainment),
      regeneratedDerivedNoContainment: cell(s.regenerated.derivedNoContainment),
    }).toEqual({
      matchedLazyEnforced: [9, 3, 6],
      matchedDerivedEnforced: [3, 3, 0],
      matchedLazyNoContainment: [9, 0, 9],
      matchedDerivedNoContainment: [0, 0, 0],
      regeneratedDerivedEnforced: [3, 3, 0],
      regeneratedLazyNoContainment: [13, 1, 12],
      regeneratedDerivedNoContainment: [1, 1, 0],
    });
    // Derived cuts remove EVERY divergence, in both methods: the stale stored
    // cut is the only thing in this model that makes two applied orders
    // disagree. That is the mechanism claim, not a coincidence of counts.
    expect(s.matched.derivedEnforced.unsoundDiverged).toBe(0);
    expect(s.matched.derivedNoContainment.unsoundDiverged).toBe(0);
    expect(s.regenerated.derivedEnforced.unsoundDiverged).toBe(0);
    expect(s.regenerated.derivedNoContainment.unsoundDiverged).toBe(0);
    // The three that survive derived cuts are exactly the three the baseline
    // recorded as apply-failures, on the same schedules.
    expect(s.matched.derivedEnforced.unsoundScheduleIndices).toEqual([258, 401, 599]);
    expect(s.matched.lazyEnforced.unsoundScheduleIndices).toEqual(
      expect.arrayContaining([...s.matched.derivedEnforced.unsoundScheduleIndices]),
    );
  }, 300_000);

  it('the matched grid changes ONE variable: its baseline cell IS the published ablation', async () => {
    // If the schedule stream moved, the cells would not be an attribution of
    // the same events and the whole grid would be uninterpretable.
    const [s, ablation] = await Promise.all([
      runDerivedCutSensitivity({ schedules: SCHEDULES, seed: SEED }),
      runSpatialAblation({ schedules: SCHEDULES, seed: SEED, verifyEvery: 0 }),
    ]);
    expect(s.matched.lazyEnforced.unsoundAutoMerges).toBe(ablation.unsoundAutoMerges);
    expect(s.matched.lazyEnforced.unsoundScheduleIndices).toEqual(ablation.unsoundScheduleIndices);
    expect(s.matched.lazyEnforced.autoMerged).toBe(ablation.autoMerged);
    for (const key of ['derivedEnforced', 'lazyNoContainment', 'derivedNoContainment'] as const) {
      expect(s.matched[key].generatorSemantics).toEqual(DEFAULT_MERGE_SEMANTICS);
      expect(s.matched[key].schedulesRegenerated).toBe(false);
      expect(s.regenerated[key].schedulesRegenerated).toBe(true);
      expect(s.regenerated[key].generatorSemantics).toEqual(s.regenerated[key].semantics);
    }
  }, 300_000);

  it('is deterministic under a fixed seed', async () => {
    const strip = (r: Awaited<ReturnType<typeof runDerivedCutSensitivity>>) => {
      const { elapsedMs: _e, ...rest } = r;
      return rest;
    };
    const [first, second] = await Promise.all([
      runDerivedCutSensitivity({ schedules: 40, seed: 7 }),
      runDerivedCutSensitivity({ schedules: 40, seed: 7 }),
    ]);
    expect(strip(second)).toEqual(strip(first));
  }, 180_000);
});

/* ------------------------------------------------------------------ */
/* Wilson interval (G4 red-team review item 5)                           */
/* ------------------------------------------------------------------ */

describe('wilsonInterval', () => {
  it('reproduces the G4 review\'s interval for the restricted rate, 20/49', () => {
    // The review quotes [28.2%, 54.7%] for 20 false conflicts out of 49
    // schedules where the spatial rule fired. Verified here rather than
    // trusted, and derived rather than transcribed into the gate's output.
    const { low, high } = wilsonInterval(20, 49);
    expect(low).toBeCloseTo(0.28215238520386865, 12);
    expect(high).toBeCloseTo(0.5475268060815286, 12);
    // The claim that carries the FAIL: the interval excludes the 20% bar.
    expect(low).toBeGreaterThan(0.2);
  });

  it('brackets the point estimate and stays inside [0, 1]', () => {
    // The bracket is a claim about the MATHS, so it is asserted with a float
    // tolerance: at p = 0 or p = 1 the Wilson bound touches the point estimate
    // exactly in exact arithmetic, and a bare <= would then be decided by the
    // last bit of a sqrt rather than by the property under test.
    const EPS = 1e-12;
    for (const [successes, trials] of [[0, 10], [1, 3], [7, 7], [20, 49], [3, 1000]] as const) {
      const { low, high } = wilsonInterval(successes, trials);
      const p = successes / trials;
      expect(low).toBeGreaterThanOrEqual(0);
      expect(high).toBeLessThanOrEqual(1);
      expect(low).toBeLessThanOrEqual(p + EPS);
      expect(high).toBeGreaterThanOrEqual(p - EPS);
    }
  });

  it('does not collapse to a point at the boundaries (the reason it is Wilson, not Wald)', () => {
    // Wald would give [0, 0] for 0/50 and [1, 1] for 50/50 -- an interval that
    // claims certainty from 50 samples.
    expect(wilsonInterval(0, 50).high).toBeGreaterThan(0);
    expect(wilsonInterval(50, 50).low).toBeLessThan(1);
  });

  it('reports total ignorance for zero trials rather than a point at zero', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it('rejects impossible inputs', () => {
    expect(() => wilsonInterval(5, 4)).toThrow(/exceeds trials/);
    expect(() => wilsonInterval(-1, 4)).toThrow(/non-negative/);
    expect(() => wilsonInterval(1, Number.NaN)).toThrow(/non-negative finite/);
  });

  it('a wider z gives a wider interval', () => {
    const at95 = wilsonInterval(20, 49, Z_95);
    const at99 = wilsonInterval(20, 49, 2.5758293035489004);
    expect(at99.low).toBeLessThan(at95.low);
    expect(at99.high).toBeGreaterThan(at95.high);
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
