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
