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
): { last: number; results: boolean[] } {
    const results: boolean[] = [];
    let t = start;
    for (let i = 0; i < n; i++) {
        results.push(gov.frame(true, t));
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

test('re-probes on a new gesture, strikes out after 3 degraded gestures', () => {
    const gov = new InteractionEffectsGovernor();
    let t = 0;
    for (let gesture = 1; gesture <= 3; gesture++) {
        burst(gov, t, 6, 16.7); // calibrate refresh
        const r = burst(gov, t + 6 * 16.7, 30, 45);
        assert.equal(
            r.results[0],
            true,
            `gesture ${gesture} starts with an effects-on probe`,
        );
        assert.equal(
            r.results[r.results.length - 1],
            false,
            `gesture ${gesture} degrades under sustained misses`,
        );
        t = r.last + 1000; // idle gap -> next gesture
        gov.frame(false, t - 500);
    }
    assert.equal(gov.isPermanentlyDegraded(), true);
    // Fourth gesture: no more probing, degraded from the first frame.
    const r4 = burst(gov, t, 10, 16.7);
    assert.ok(r4.results.every(v => v === false), 'struck out: no re-probe');
});

test('burst gap is not counted as a missed frame', () => {
    const gov = new InteractionEffectsGovernor();
    let t = 0;
    // Many short steady gestures separated by long idle gaps.
    for (let i = 0; i < 10; i++) {
        const { last } = burst(gov, t, 10, 16.7);
        t = last + 2000;
        gov.frame(false, t - 1000);
    }
    const { results } = burst(gov, t, 20, 16.7);
    assert.ok(results.every(Boolean), 'gaps between gestures never degrade');
});
