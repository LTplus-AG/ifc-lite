/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Capped timing: inside a cap window the under-load flag means the benchmark itself was starved (its own CPU
// pressure, uncapped builders), a sample only partly inside a window is flagged, and outside a window nothing changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capWindowOf, classifyCappedLoad, readCapState, isCapped } from './load-scoreboard-cap.mjs';

const T3 = '/user.slice/user-1000.slice/user@1000.service/app.slice/app-t3code.slice';
const st = (over = {}) => ({ id: 'w1', allowanceCores: 2, appliedMs: 1000, restoredMs: null, cappedPaths: [T3], ...over });

test('the window of a sample: inside only when open at both ends in the same window; partial otherwise; none without one', () => {
  assert.equal(capWindowOf(null, null, 2000, 3000), 'none');
  assert.equal(capWindowOf(st(), st(), 2000, 3000), 'inside');
  assert.equal(capWindowOf(st(), st({ restoredMs: 2500 }), 2000, 3000), 'partial'); // restored mid-sample
  assert.equal(capWindowOf(st({ appliedMs: 2500 }), st({ appliedMs: 2500 }), 2000, 3000), 'partial'); // opened mid-sample
  assert.equal(capWindowOf(st(), st({ id: 'w2' }), 2000, 3000), 'partial');
  assert.equal(capWindowOf(st({ restoredMs: 1500 }), st({ restoredMs: 1500 }), 2000, 3000), 'none'); // an old, closed window
  assert.equal(capWindowOf(st(), { error: 'bad json' }, 2000, 3000), 'partial');
  // Applied and restored entirely inside the sample: neither end is capped, but the sample overlaps the window.
  assert.equal(capWindowOf(st({ appliedMs: 2500, restoredMs: 2800 }), st({ appliedMs: 2500, restoredMs: 2800 }), 2000, 3000), 'partial');
});

test('in a window: own starvation or an uncapped busy builder flags; a capped builder does not; partial always flags', () => {
  const base = { window: 'inside', limit: 5, cappedPaths: [T3] };
  assert.equal(classifyCappedLoad({ ...base, ownStallPct: 1.2 }).underLoad, false);
  assert.match(classifyCappedLoad({ ...base, ownStallPct: 7 }).reason, /benchmark tasks waited for a CPU 7\.0%/);
  assert.equal(classifyCappedLoad({ ...base, ownStallPct: null }).underLoad, true); // unreadable is never quiet
  const capped = classifyCappedLoad({ ...base, ownStallPct: 0, builders: ['turbo'], builderCpuMs: { [`${T3}/t3code-claude-x.scope`]: 5000 } });
  assert.deepEqual([capped.underLoad, capped.builderState], [false, 'capped']);
  const free = classifyCappedLoad({ ...base, ownStallPct: 0, builders: ['rustc'], builderCpuMs: { '/user.slice/user-1000.slice/session-7123.scope': 400 } });
  assert.equal(free.underLoad, true);
  assert.match(free.reason, /uncapped builder/);
  assert.match(classifyCappedLoad({ ...base, window: 'partial', ownStallPct: 0 }).reason, /partly inside the cap window/);
});

test('the state file cap.py exports is read with its allowance and capped cgroups; unreadable is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  const file = join(dir, 's.json');
  writeFileSync(file, JSON.stringify({ id: 'w9', cores: 2, appliedEpoch: 10, entries: [{ path: T3, new: '20000 100000' }, { path: '/x', new: null }] }));
  assert.deepEqual(readCapState(file), { id: 'w9', allowanceCores: 2, appliedMs: 10000, restoredMs: null, cappedPaths: [T3] });
  writeFileSync(file, '{');
  assert.ok(readCapState(file).error);
  assert.equal(readCapState(''), null);
  assert.equal(isCapped(`${T3}/a.scope`, [T3]), true);
  assert.equal(isCapped(`${T3}x`, [T3]), false);
});

test('a sample settled inside an open window records the window and allowance and is judged on its own pressure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  const file = join(dir, 's.json');
  writeFileSync(file, JSON.stringify({ id: 'live', cores: 2, appliedEpoch: Date.now() / 1000 - 5, entries: [] }));
  process.env.LOAD_SCOREBOARD_CAP_STATE = file;
  try {
    const { hostQuiet, settleHostLoad } = await import('./load-scoreboard-host.mjs');
    const host = await hostQuiet({ maxWaitMs: 0 });
    assert.equal(host.pressureSource, 'benchmark cgroup (cap window)');
    settleHostLoad(host);
    assert.equal(host.cap.window, 'inside');
    assert.equal(host.cap.allowanceCores, 2);
    assert.ok(host.cap.ownStallPct === null || host.cap.ownStallPct >= 0);
    // Restored before the sample ends: partial, flagged.
    const h2 = await hostQuiet({ maxWaitMs: 0 });
    writeFileSync(file, JSON.stringify({ id: 'live', cores: 2, appliedEpoch: Date.now() / 1000 - 5, restoredEpoch: Date.now() / 1000, entries: [] }));
    await new Promise((r) => setTimeout(r, 5));
    settleHostLoad(h2);
    assert.deepEqual([h2.cap.window, h2.underLoad], ['partial', true]);
  } finally { delete process.env.LOAD_SCOREBOARD_CAP_STATE; }
  const { hostQuiet, settleHostLoad } = await import('./load-scoreboard-host.mjs');
  const outside = settleHostLoad(await hostQuiet({ maxWaitMs: 0 }));
  assert.deepEqual([outside.cap.window, outside.pressureSource], ['none', 'host']);
});

test('an arm-lane sample gets the plan or side cpuTrace option and settles its host with the browser outside the job cgroup', async () => {
  const { recordArmLanes } = await import('./load-scoreboard.mjs');
  const calls = [], rows = [];
  const sample = async (args) => { calls.push(args); return { lanes: {}, meta: { pageErrors: [], browserOutside: { cpuMs: 1e9, pressureUs: 0 } } }; };
  const plan = { cpuTrace: true, warmOpens: 0, sides: { base: { label: 'b' }, branch: { label: 'r', cpuTrace: false } } };
  for (const side of ['base', 'branch']) {
    const cell = { group: 'browser', fixture: 'FZK', round: 0, side };
    await recordArmLanes({ sample, plan, side, fixture: { name: 'FZK' }, cell, missing: ['browser-cold-early'], groupLanes: ['browser-cold-early'],
      tag: `FZK-${side}-r0`, common: { ...cell }, record: (row) => rows.push(row), traces: tmpdir() });
  }
  assert.deepEqual(calls.map((c) => c.cpuTrace), [true, false]);
  const host = rows[0].host;
  if (host.foreignCpuMs !== null) assert.deepEqual([host.foreignCpuMs, host.ownOutsideCgroupCpuMs], [0, 1e9]);
});
