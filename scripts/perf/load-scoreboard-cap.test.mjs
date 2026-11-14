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
  // Unreadable cap state: the cap is unknown (the host rule judges the sample), never a reason to drop it.
  assert.equal(capWindowOf(st(), { error: 'bad json' }, 2000, 3000), 'unknown');
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
    // The flag uses the upper bound of the union (job + browser scope, capped at 100 %); the range is recorded.
    const h3 = await hostQuiet({ maxWaitMs: 0 });
    const t3 = Date.now(); while (Date.now() - t3 < 5) { /* a non-empty sample */ }
    settleHostLoad(h3, { ownOutside: { cpuMs: 0, pressureUs: 5 } });
    if (h3.cap.jobStallUs !== null) {
      assert.equal(h3.cap.ownStallPct, Math.round(Math.min(100, ((h3.cap.jobStallUs + 5) / (h3.sampleMs * 1000)) * 100) * 10) / 10);
      assert.ok(h3.cap.ownStallRangePct[0] <= h3.cap.ownStallRangePct[1]);
    }
    assert.equal(h3.cap.browserStallUs, 5);
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

test('benchmark stall in a cap window: the range [max, min(sum, 100%)] is reported and the flag uses the sum', async () => {
  const { stallRange } = await import('./load-scoreboard-cap.mjs');
  // 4 ms in the job cgroup + 4 ms in the browser scope in a 100 ms sample: 4-8 %; the sum (8 %) flags at the 5 % limit.
  assert.deepEqual(stallRange(4000, 4000, 100), { lowPct: 4, highPct: 8, browserUnknown: false });
  assert.equal(classifyCappedLoad({ window: 'inside', ownStallPct: stallRange(4000, 4000, 100).highPct, limit: 5 }).underLoad, true);
  assert.deepEqual(stallRange(90000, 50000, 100), { lowPct: 90, highPct: 100, browserUnknown: false }); // capped at 100 %
  assert.deepEqual(stallRange(1000, 0, 100), { lowPct: 1, highPct: 1, browserUnknown: false }); // no browser scope: 0
  assert.deepEqual(stallRange(null, 5, 100), { lowPct: null, highPct: null, browserUnknown: false });
});

test('the foreign-CPU interval ends at the cut taken before Chrome closes, so its shutdown CPU is not foreign', async () => {
  const { hostQuiet, settleHostLoad } = await import('./load-scoreboard-host.mjs');
  const host = await hostQuiet({ maxWaitMs: 0 });
  if (!Number.isFinite(host.hostBusyBefore) || !Number.isFinite(host.ownCgroupBefore)) return; // no /proc/stat or cgroup here
  const cut = { cpuMs: 200, pressureUs: 0, hostBusyMs: host.hostBusyBefore + 1000, ownCgroupMs: host.ownCgroupBefore + 300 };
  // Burn CPU after the cut: it must not change the figure.
  const t = Date.now(); while (Date.now() - t < 50) { /* busy */ }
  settleHostLoad(host, { ownOutside: cut });
  assert.equal(host.foreignCpuMs, 500); // 1000 host busy - 300 job - 200 browser scope, all at the cut
});

test('an unreadable browser-scope reading is unknown, never zero: no foreign figure, and a capped sample is flagged', async () => {
  const { stallRange: sr } = await import('./load-scoreboard-cap.mjs');
  const { outsideOwnCgroup } = await import('./load-scoreboard-host.mjs');
  // A scope outside the job cgroup whose cpu.stat and cpu.pressure cannot be read.
  const o = outsideOwnCgroup([1], { cgroupOf: () => '/elsewhere.scope', usage: () => null, pressure: () => null });
  assert.deepEqual([o.cpuMs, o.pressureUs, o.scopes], [null, null, 1]);
  const ok = outsideOwnCgroup([1], { cgroupOf: () => '/elsewhere.scope', usage: () => 12, pressure: () => ({ avg10: 0, totalUs: 34 }) });
  assert.deepEqual([ok.cpuMs, ok.pressureUs], [12, 34]);
  assert.equal(sr(1000, null, 100).browserUnknown, true);
  assert.equal(sr(1000, null, 100).highPct, null);
  const c = classifyCappedLoad({ window: 'inside', ownStallPct: null, browserStallUnknown: true, limit: 5 });
  assert.deepEqual([c.underLoad, c.reason], [true, 'browser stall unreadable in the cap window']);
  // settleHostLoad: unknown browser CPU makes foreignCpuMs unknown, not "host minus job".
  const { hostQuiet, settleHostLoad } = await import('./load-scoreboard-host.mjs');
  const h = settleHostLoad(await hostQuiet({ maxWaitMs: 0 }), { ownOutside: { cpuMs: null, pressureUs: null, scopes: 1 } });
  assert.equal(h.foreignCpuMs, null);
});

test('the pre-sample wait re-reads the cap state: a wait that crosses the end of a window restarts under the host rule', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  const file = join(dir, 's.json');
  const open = { id: 'w', cores: 2, appliedEpoch: Date.now() / 1000 - 5, entries: [] };
  writeFileSync(file, JSON.stringify(open));
  process.env.LOAD_SCOREBOARD_CAP_STATE = file;
  try {
    const { hostQuiet } = await import('./load-scoreboard-host.mjs');
    setTimeout(() => writeFileSync(file, JSON.stringify({ ...open, restoredEpoch: Date.now() / 1000 })), 1200);
    const h = await hostQuiet({ limit: 0, maxWaitMs: 1500 }); // limit 0: never quiet, so the wait runs its course
    assert.equal(h.pressureSource, 'host');
    assert.ok(h.capBoundariesInWait >= 1);
    assert.ok(h.capBefore.restoredMs !== null);
  } finally { delete process.env.LOAD_SCOREBOARD_CAP_STATE; }
});

test('cgroup membership that cannot be resolved is unknown: unreadable own cgroup or a live process with no readable cgroup', async () => {
  const { outsideOwnCgroup } = await import('./load-scoreboard-host.mjs');
  const io = { usage: () => 10, pressure: () => ({ avg10: 0, totalUs: 1 }) };
  assert.deepEqual([outsideOwnCgroup([5], { ...io, own: null, cgroupOf: () => '/x.scope' })].map((o) => [o.cpuMs, o.pressureUs]), [[null, null]]);
  const live = outsideOwnCgroup([5], { ...io, own: '/job.scope', cgroupOf: () => null, alive: () => true });
  assert.deepEqual([live.cpuMs, live.pressureUs, live.unresolved], [null, null, true]);
  const gone = outsideOwnCgroup([5], { ...io, own: '/job.scope', cgroupOf: () => null, alive: () => false });
  assert.deepEqual([gone.cpuMs, gone.pressureUs], [0, 0]); // exited in between: nothing left to attribute
});

test('the stall share uses the interval between its two counter reads (sample start and end), not one widened by diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  const file = join(dir, 's.json');
  writeFileSync(file, JSON.stringify({ id: 'w', cores: 2, appliedEpoch: Date.now() / 1000 - 5, entries: [] }));
  process.env.LOAD_SCOREBOARD_CAP_STATE = file;
  try {
    const { hostQuiet, settleHostLoad } = await import('./load-scoreboard-host.mjs');
    // Injected boundary reads: start (stall 1,000 us at t0), end (stall 5,000 us at t0 + 100 ms). Any read taken
    // elsewhere (before or after the diagnostics) would not see these values: 4 ms of stall in 100 ms is 4.0 %.
    const t0 = Date.now();
    const reads = [[1000, t0], [5000, t0 + 100]];
    let i = 0, last = null;
    const io = { ownStallUs: () => (last = reads[Math.min(i++, 1)])[0], now: () => last[1] };
    const h = await hostQuiet({ maxWaitMs: 0, io });
    settleHostLoad(h, { ownOutside: { cpuMs: 0, pressureUs: 0, scopes: 0 }, io });
    assert.equal(h.cap.window, 'inside');
    assert.equal(h.sampleMs, 100);
    assert.equal(h.cap.jobStallUs, 4000);
    assert.equal(h.cap.ownStallPct, 4);
    assert.equal(h.cap.stallWindowMs, 100);
  } finally { delete process.env.LOAD_SCOREBOARD_CAP_STATE; }
});

test('an unreadable cap state leaves the sample to the ordinary host rule and records the error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  const file = join(dir, 's.json');
  writeFileSync(file, '{ not json');
  process.env.LOAD_SCOREBOARD_CAP_STATE = file;
  try {
    const { hostQuiet, settleHostLoad } = await import('./load-scoreboard-host.mjs');
    const h = settleHostLoad(await hostQuiet({ maxWaitMs: 0 }));
    assert.equal(h.cap.window, 'unknown');
    assert.equal(typeof h.cap.error, 'string');
    assert.notEqual(h.reason, 'sample only partly inside the cap window');
  } finally { delete process.env.LOAD_SCOREBOARD_CAP_STATE; }
});

test('a boot row is settled with its own browser outside the job cgroup (settleRowHost)', async () => {
  const { settleRowHost } = await import('./load-scoreboard.mjs');
  const { hostQuiet } = await import('./load-scoreboard-host.mjs');
  const host = await hostQuiet({ maxWaitMs: 0 });
  if (!Number.isFinite(host.hostBusyBefore) || !Number.isFinite(host.ownCgroupBefore)) return;
  const row = settleRowHost({ host, browserOutside: { cpuMs: 200, pressureUs: 0, scopes: 1, hostBusyMs: host.hostBusyBefore + 1000, ownCgroupMs: host.ownCgroupBefore + 300 } });
  assert.equal(row.host.foreignCpuMs, 500);
  assert.equal('browserOutside' in row, false);
});
