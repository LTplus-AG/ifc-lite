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
  assert.equal(inside.quietAtArmMs, 0, 'and had no quiet at all (review #9815)');
  const later = quietAtArm([[0, 100], [5000, 500]], 2100);
  assert.equal(later.quietAtArmMs, 2000, 'a task that starts after the arm does not count');
  assert.equal(later.armInsideLongTask, false, 'no task spans the arm');
  const none = quietAtArm([], 2100);
  assert.equal(none.quietAtArmMs, null, 'no long task before the arm: no quiet value');
  assert.equal(none.armedEarly, false, 'and not early');
  assert.equal(quietAtArm([[0, 1]], undefined).armedEarly, null, 'no arm time: unknown, not a pass');
});

/** Block this thread for `ms` (a real long task: timers cannot run meanwhile). */
function blockFor(ms) { const end = performance.now() + ms; while (performance.now() < end) { /* busy */ } return end; }

/** watchQuietInPage on this thread with a block at `atMs` lasting `ms`, its entry never reported (the stale case). */
async function armAround(watchQuietInPage, { atMs, ms, quietMs = 300 }) {
  globalThis.__benchLongTasks = [];
  let blockEnd = null;
  const started = performance.now();
  if (atMs !== null) setTimeout(() => { blockEnd = blockFor(ms); }, atMs);
  const r = await watchQuietInPage({ quietMs, timeoutMs: 5000, tickMs: 16, slackMs: 50 });
  delete globalThis.__benchLongTasks;
  return { ...r, started, blockEnd };
}

test('the arm waits a full quiet window after a long block whose entry was never reported (quiet-arm note, 2026-11-12)', async () => {
  const { watchQuietInPage } = await load('./viewer-load-boot.mjs');
  const r = await armAround(watchQuietInPage, { atMs: 100, ms: 400 });
  assert.equal(r.timedOut, false);
  assert.ok(r.lateTicks >= 1, 'the block was seen as a late tick');
  assert.ok(r.armAbs - r.blockEnd >= 300, `armed ${(r.armAbs - r.blockEnd).toFixed(0)} ms after the block; must be >= 300`);
});

test('a short long task that delays a tick by less than the old 150 ms margin also restarts the window (review #9815)', async () => {
  const { watchQuietInPage } = await load('./viewer-load-boot.mjs');
  const r = await armAround(watchQuietInPage, { atMs: 200, ms: 100 });
  assert.ok(r.armAbs - r.blockEnd >= 300, `armed ${(r.armAbs - r.blockEnd).toFixed(0)} ms after a 100 ms task; must be >= 300`);
});

test('a quiet page arms after one window, and a reported recent entry still counts', async () => {
  const { watchQuietInPage } = await load('./viewer-load-boot.mjs');
  const quiet = await armAround(watchQuietInPage, { atMs: null, ms: 0 });
  assert.ok(quiet.armAbs - quiet.started >= 300 && quiet.armAbs - quiet.started < 600, `quiet page armed after ${(quiet.armAbs - quiet.started).toFixed(0)} ms`);
  const now = performance.now();
  globalThis.__benchLongTasks = [[now - 50, 150]]; // ends 100 ms in the future of `now`, as reported
  const r = await watchQuietInPage({ quietMs: 300, timeoutMs: 5000, tickMs: 16, slackMs: 50 });
  delete globalThis.__benchLongTasks;
  assert.ok(r.armAbs - (now + 100) >= 300, 'a reported task end restarts the window');
});

test('waitShellQuiet arms from the in-page watcher and reports its late ticks', async () => {
  const { waitShellQuiet } = await load('./viewer-load-boot.mjs');
  globalThis.__benchLongTasks = [];
  const page = { evaluate: (fn, arg) => fn(arg) };
  setTimeout(() => blockFor(200), 50);
  const shell = await waitShellQuiet(page, { quietMs: 300, timeoutMs: 5000 });
  delete globalThis.__benchLongTasks;
  assert.equal(shell.timedOut, false);
  assert.ok(shell.lateTicks >= 1);
  assert.equal(shell.armAbs, shell.shellQuietMs);
});
