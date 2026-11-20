/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { Renderer } from '@ifc-lite/renderer';
import { recordFedVisibility } from '@/lib/geometry-backing/readback-coverage';
import { invalidatePendingMeasureReadbacks, measureReadbacksIdle, runAfterMeasureReadbacks, runWithReadback } from './measureReadbackGate';

/** A released scene whose renderer reports coverage for the last fed ray. */
function released(covers = false) {
  return { getScene: () => ({ isGeometryDataReleased: () => true }), readbackRaycastCovers: () => covers } as unknown as Renderer;
}
let shared = released(true);
const none = { hiddenIds: new Set<number>(), isolatedIds: null };

describe('measure readback gate (#10884)', () => {
  beforeEach(() => { shared = released(true); });

  it('coverage needs the pieces to have been prepared under the CURRENT hide/isolate state', async () => {
    recordFedVisibility(shared, { hiddenIds: new Set([7]), isolatedIds: null }); // fed while surface 7 was hidden
    const runs: string[] = [];
    const deferred = runWithReadback(shared, 1, 1, none, () => runs.push('act'), undefined, async () => { runs.push('read'); return 'fed'; });
    assert.equal(deferred, true, 'unhiding 7 needs a new read, even at the same ray');
    await measureReadbacksIdle();
    assert.deepEqual(runs, ['read', 'act']);
    recordFedVisibility(shared, none);
    assert.equal(runWithReadback(shared, 1, 1, none, () => runs.push('sync')), false, 'same ray, same visibility: covered');
  });

  it('a read a hover cancelled is retried; an action never runs as if fed when it was not', async () => {
    const runs: string[] = [];
    let calls = 0;
    runWithReadback(released(), 1, 1, none, () => runs.push('A'), undefined, async () => (++calls === 1 ? 'cancelled' : 'fed'));
    await measureReadbacksIdle();
    assert.deepEqual(runs, ['A'], 'retried once, then acted');
    runWithReadback(released(), 2, 2, none, () => runs.push('B'), undefined, async () => 'cancelled');
    await measureReadbacksIdle();
    assert.deepEqual(runs, ['A'], 'cancelled twice: dropped, never run uncovered');
  });

  it('two gestures read one after another: B never cancels A, and A acts before B', async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runWithReadback(released(), 1, 1, none, () => log.push('act A'), undefined, async () => { log.push('read A'); await gate; return 'fed'; });
    runWithReadback(released(), 2, 2, none, () => log.push('act B'), undefined, async () => { log.push('read B'); return 'fed'; });
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(log, ['read A'], 'B waits for A');
    release();
    await measureReadbacksIdle();
    assert.deepEqual(log, ['read A', 'act A', 'read B', 'act B']);
  });

  it('Esc (a reset) during the read drops the deferred action', async () => {
    const runs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runWithReadback(released(), 1, 1, none, () => runs.push('drag'), undefined, async () => { await gate; return 'fed'; });
    await new Promise((r) => setTimeout(r, 0));
    invalidatePendingMeasureReadbacks(); // resetMeasurePress
    release();
    await measureReadbacksIdle();
    assert.deepEqual(runs, [], 'no snap or rubber band written back after the reset');
  });

  it('a tool switch during the read drops the deferred action (the caller fence)', async () => {
    const runs: string[] = [];
    let tool = 'measure';
    runWithReadback(released(), 1, 1, none, () => runs.push('place'), () => tool === 'measure', async () => { tool = 'select'; return 'fed'; });
    await measureReadbacksIdle();
    assert.deepEqual(runs, []);
  });

  it('#10884 coverage is per renderer: another canvas fed without the hidden surface does not cover this one', async () => {
    const a = released(true), b = released(true);
    recordFedVisibility(a, { hiddenIds: new Set([7]), isolatedIds: null });
    recordFedVisibility(b, none);
    const runs: string[] = [];
    assert.equal(runWithReadback(a, 1, 1, none, () => runs.push('A'), undefined, async () => 'fed'), true, "B's record never covers A's stale pieces");
    await measureReadbacksIdle();
    assert.deepEqual(runs, ['A']);
  });

  it('#10884 a double-click finish runs after the clicks still reading back, never before them', async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runWithReadback(released(), 1, 1, none, () => log.push('last vertex'), undefined, async () => { await gate; return 'fed'; });
    assert.equal(runAfterMeasureReadbacks(() => log.push('finish')), true, 'deferred behind the pending click');
    release();
    await measureReadbacksIdle();
    assert.deepEqual(log, ['last vertex', 'finish']);
    assert.equal(runAfterMeasureReadbacks(() => log.push('immediate')), false, 'nothing pending: runs now');
  });
});

