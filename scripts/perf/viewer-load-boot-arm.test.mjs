/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The quiet-shell arm: the load clock must start only after the main thread
// really was free of long tasks for `quietMs`, including a block whose
// longtask entries had not arrived when the poll ran.

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function load(path) {
  let failure = null;
  const mod = await import(path).catch((error) => { failure = error; return null; });
  assert.ok(mod, `${path} did not load (${failure?.name ?? 'unknown'})`);
  return mod;
}

test('quietAtArm measures from the last long task that ended before the arm', async () => {
  const { quietAtArm } = await load('./viewer-load-boot.mjs');
  // A 1.6 s block ending at 3000, armed 20 ms later: the late-delivered case.
  const early = quietAtArm([[100, 200], [1400, 1600]], 3020);
  assert.equal(early.quietAtArmMs, 20, 'quiet = arm - end of the block');
  assert.equal(early.armedEarly, true, 'under 1 s of real quiet is an early arm');
  assert.equal(early.armInsideLongTask, false, 'the block had ended');
  const ok = quietAtArm([[100, 200], [1400, 1600]], 4050);
  assert.equal(ok.quietAtArmMs, 1050, 'quiet measured from the block end');
  assert.equal(ok.armedEarly, false, 'more than 1 s of quiet is a proper arm');
});

test('quietAtArm flags an arm inside a long task and ignores tasks after it', async () => {
  const { quietAtArm } = await load('./viewer-load-boot.mjs');
  const inside = quietAtArm([[0, 100], [2000, 500]], 2200);
  assert.equal(inside.armInsideLongTask, true, 'the arm fell inside [2000, 2500)');
  assert.equal(inside.armedEarly, true, 'an arm inside a long task is early');
  const later = quietAtArm([[0, 100], [5000, 500]], 2100);
  assert.equal(later.quietAtArmMs, 2000, 'a task that starts after the arm does not count');
  assert.equal(later.armInsideLongTask, false, 'no task spans the arm');
  const none = quietAtArm([], 2100);
  assert.equal(none.quietAtArmMs, null, 'no long task before the arm: no quiet value');
  assert.equal(none.armedEarly, false, 'and not early');
  assert.equal(quietAtArm([[0, 1]], undefined).armedEarly, null, 'no arm time: unknown, not a pass');
});

/** A page whose main thread runs one long block; its longtask entry is delivered `deliverMs` after the block ends. */
function blockedPage({ quietBefore, blockStart, blockEnd, deliverMs, pollCostMs = 10, pollMs = 100 }) {
  let clock = 1100;
  return {
    async waitForTimeout(ms) { clock += ms; },
    async evaluate() {
      clock += pollCostMs;
      if (clock > blockStart && clock < blockEnd) clock = blockEnd + 1; // the poll waits for the block
      const delivered = clock >= blockEnd + deliverMs;
      return { now: clock, lastLongTaskEnd: delivered ? blockEnd : quietBefore, longTaskMs: 0, longTasks: 0, rendererReady: true, countersOff: true };
    },
    pollMs,
  };
}

test('waitShellQuiet never arms right after a long block whose entry was not delivered yet (quiet-arm note, 2026-11-12)', async () => {
  const { waitShellQuiet, quietAtArm } = await load('./viewer-load-boot.mjs');
  // Boot tasks ended at 1000; a 1.6 s welcome block runs 1500-3100; its entry arrives 40 ms after it ends.
  const page = blockedPage({ quietBefore: 1000, blockStart: 1500, blockEnd: 3100, deliverMs: 40 });
  const shell = await waitShellQuiet(page);
  assert.equal(shell.timedOut, false, 'the arm settles');
  assert.ok(shell.latePolls >= 1, 'the poll held up by the block is counted late');
  const real = quietAtArm([[0, 1000], [1500, 1600]], shell.armAbs);
  assert.equal(real.armedEarly, false, `armed with ${real.quietAtArmMs} ms of real quiet; must be >= 1000`);
});

test('shellArm: two polls minimum, late polls restart the window, ordinary polls do not', async () => {
  const { shellArm } = await load('./viewer-load-boot.mjs');
  const a = shellArm();
  assert.equal(a.poll({ now: 5000, lastLongTaskEnd: 100 }), false, 'one poll never arms, however old the last task');
  assert.equal(a.poll({ now: 5110, lastLongTaskEnd: 100 }), true, 'a second on-time poll arms after long quiet');
  const b = shellArm();
  b.poll({ now: 1100, lastLongTaskEnd: 0 });
  assert.equal(b.poll({ now: 2700, lastLongTaskEnd: 0 }), false, 'a poll 1.6 s after the previous one ran late');
  assert.equal(b.latePolls, 1, 'counted');
  assert.equal(b.poll({ now: 2810, lastLongTaskEnd: 0 }), false, 'the window restarted at the late poll');
  let t = 2810;
  while (!b.quiet) { t += 110; b.poll({ now: t, lastLongTaskEnd: 0 }); }
  assert.ok(t - 2700 >= 1000 && t - 2700 < 1110, `arms one window after the late poll (at ${t})`);
});
