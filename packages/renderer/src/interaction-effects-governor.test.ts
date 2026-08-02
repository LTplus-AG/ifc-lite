/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InteractionEffectsGovernor } from './interaction-effects-governor.js';

/** Drive the governor through `n` interactive frames spaced `delta` apart. */
function burst(
    gov: InteractionEffectsGovernor,
    start: number,
    n: number,
    delta: number,
    unstable = false,
    expectedIntervalMs = 0,
): { last: number; results: boolean[] } {
    const results: boolean[] = [];
    let t = start;
    for (let i = 0; i < n; i++) {
        results.push(gov.frame(true, t, unstable, expectedIntervalMs));
        t += delta;
    }
    return { last: t - delta, results };
}

test('idle frames always allow effects', () => {
    const gov = new InteractionEffectsGovernor();
    assert.equal(gov.frame(false, 0), true);
    assert.equal(gov.frame(false, 1000), true);
});

test('steady 60 Hz interaction keeps effects on', () => {
    const gov = new InteractionEffectsGovernor();
    const { results } = burst(gov, 0, 120, 16.7);
    assert.ok(results.every(Boolean), 'no frame degraded at steady vsync cadence');
});

test('steady 120 Hz interaction keeps effects on', () => {
    const gov = new InteractionEffectsGovernor();
    const { results } = burst(gov, 0, 120, 8.3);
    assert.ok(results.every(Boolean));
});

test('sustained missed frames degrade within the window', () => {
    const gov = new InteractionEffectsGovernor();
    // Establish the refresh estimate at ~16.7ms, then stall at 40ms/frame.
    const { last } = burst(gov, 0, 10, 16.7);
    const { results } = burst(gov, last + 40, 24, 40);
    assert.equal(results[0], true, 'probe frames render with effects');
    assert.equal(results[results.length - 1], false, 'sustained misses degrade');
});

test('a brief hitch (GC pause) does not degrade', () => {
    const gov = new InteractionEffectsGovernor();
    const { last } = burst(gov, 0, 30, 16.7);
    // 3 slow frames, then steady again — under the 6-miss limit.
    const { last: l2 } = burst(gov, last + 50, 3, 50);
    const { results } = burst(gov, l2 + 16.7, 40, 16.7);
    assert.ok(results.every(Boolean), 'recovered without degrading');
});

test('streaming frames are excluded from the verdict', () => {
    const gov = new InteractionEffectsGovernor();
    // Slow frames during streaming must not degrade (regression: the
    // "load model, orbit immediately" path struck out the whole session).
    const { last } = burst(gov, 0, 60, 80, /* unstable */ true);
    assert.equal(gov.frame(true, last + 80, true), true, 'still on after streaming jank');
    // Steady non-streaming interaction afterwards stays on.
    const { results } = burst(gov, last + 160, 60, 16.7);
    assert.ok(results.every(Boolean));
});

test('degradation is not permanent: re-probes after the cooldown', () => {
    const gov = new InteractionEffectsGovernor();
    burst(gov, 0, 10, 16.7);
    const r1 = burst(gov, 10 * 16.7, 30, 45);
    assert.equal(r1.results[r1.results.length - 1], false, 'degraded');
    // New gesture immediately after: still inside the cooldown -> stays off.
    gov.frame(false, r1.last + 300);
    const r2 = burst(gov, r1.last + 600, 5, 16.7);
    assert.ok(r2.results.every(v => v === false), 'cooldown holds');
    // After the cooldown a new gesture re-probes with effects on.
    gov.frame(false, r1.last + 4000);
    const r3 = burst(gov, r1.last + 5000, 5, 16.7);
    assert.equal(r3.results[0], true, 're-probes after cooldown');
});

test('a clean gesture after re-probe forgives strikes', () => {
    const gov = new InteractionEffectsGovernor();
    burst(gov, 0, 10, 16.7);
    const r1 = burst(gov, 10 * 16.7, 30, 45); // strike 1
    assert.equal(r1.results[r1.results.length - 1], false);
    // Past the cooldown: long clean gesture resets the penalty.
    const t2 = r1.last + 5000;
    const r2 = burst(gov, t2, 60, 16.7);
    assert.equal(r2.results[0], true, 're-probed');
    assert.ok(r2.results.every(Boolean), 'clean gesture stays on');
    // Next degradation behaves like the first (base cooldown, not escalated):
    const r3 = burst(gov, r2.last + 1000, 30, 45);
    assert.equal(r3.results[r3.results.length - 1], false, 'degrades again');
    const r4 = burst(gov, r3.last + 3500, 5, 16.7);
    assert.equal(r4.results[0], true, 'base cooldown applies after forgiveness');
});

test('repeated degradation escalates the cooldown', () => {
    const gov = new InteractionEffectsGovernor();
    let t = 0;
    let lastEnd = 0;
    // Three degraded gestures, each separated by enough idle to re-probe.
    for (let i = 0; i < 3; i++) {
        burst(gov, t, 6, 16.7);
        const r = burst(gov, t + 6 * 16.7, 30, 45);
        assert.equal(r.results[r.results.length - 1], false, `gesture ${i + 1} degrades`);
        lastEnd = r.last;
        t = r.last + 70_000; // beyond even the max cooldown
    }
    // Strikes = 3 -> cooldown 12s. A gesture ~6s after the third strike
    // stays degraded; the base 3s cooldown would have re-probed already.
    const r6sec = burst(gov, lastEnd + 6000, 5, 16.7);
    assert.ok(r6sec.results.every(v => v === false), 'escalated cooldown holds at ~6s');
});

test('a GPU stuck at ~30fps degrades even with no fast frames to calibrate', () => {
    // Codex P1: with the old 25ms refresh clamp, a 33ms cadence never
    // counted as missed. The 17ms clamp assumes at least a 60Hz display
    // when the app declares no slower schedule.
    const gov = new InteractionEffectsGovernor();
    const { results } = burst(gov, 0, 24, 33);
    assert.equal(results[results.length - 1], false, '33ms cadence registers misses');
});

test('app-throttled cadence is not treated as missed frames', () => {
    // The large-model interaction throttle renders at 33/25ms by design;
    // the app passes that schedule so the governor judges against it.
    const gov = new InteractionEffectsGovernor();
    const { results } = burst(gov, 0, 60, 33, false, 33);
    assert.ok(results.every(Boolean), 'throttled cadence stays clean');
    // …but a GPU falling far behind even the throttled schedule degrades.
    const r2 = burst(gov, 60 * 33 + 33, 24, 70, false, 33);
    assert.equal(r2.results[r2.results.length - 1], false, '70ms vs 33ms target degrades');
});

test('refresh estimate re-calibrates per window across display changes', () => {
    // Codex P2: a lifetime-minimum estimate from a 120Hz display made every
    // healthy 16.7ms frame on a 60Hz display look missed.
    const gov = new InteractionEffectsGovernor();
    burst(gov, 0, 60, 8.3); // 120Hz gesture
    gov.frame(false, 2000);
    // Window moved to a 60Hz display: steady 16.7ms must stay clean.
    const { results } = burst(gov, 3000, 80, 16.7);
    assert.ok(results.every(Boolean), '60Hz cadence is clean after 120Hz history');
});

test('burst gap is not counted as a missed frame', () => {
    const gov = new InteractionEffectsGovernor();
    let t = 0;
    for (let i = 0; i < 10; i++) {
        const { last } = burst(gov, t, 10, 16.7);
        t = last + 2000;
        gov.frame(false, t - 1000);
    }
    const { results } = burst(gov, t, 20, 16.7);
    assert.ok(results.every(Boolean), 'gaps between gestures never degrade');
});
