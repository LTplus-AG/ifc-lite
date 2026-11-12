/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Under-load flag = load, not a process name: a builder-named process voids a cell only when it (its process
// group) used CPU during the sample or CPU pressure was non-zero (metadata lane, job a8faf2a6: idle rustc probes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

async function load(path) {
  let failure = null;
  const mod = await import(path).catch((error) => { failure = error; return null; });
  assert.ok(mod, `${path} did not load (${failure?.name ?? 'unknown'})`);
  return mod;
}

test('a builder seen with no CPU use and zero pressure is "seen, idle" and does not flag the sample', async () => {
  const { classifyHostLoad } = await load('./load-scoreboard.mjs');
  const idle = classifyHostLoad({ psi: 0, builders: ['rustc'], groupCpuMs: { 4242: 0 } });
  assert.equal(idle.underLoad, false, idle.reason);
  assert.equal(idle.builderState, 'seen, idle');
  assert.equal(classifyHostLoad({ psi: 0, builders: [], groupCpuMs: {} }).builderState, 'none');
});

test('a builder group that used CPU, a builder under any pressure, or high pressure alone flags the sample', async () => {
  const { classifyHostLoad } = await load('./load-scoreboard.mjs');
  const busy = classifyHostLoad({ psi: 0, builders: ['rustc'], groupCpuMs: { 4242: 850 } });
  assert.equal(busy.underLoad, true);
  assert.equal(busy.builderState, 'busy');
  assert.deepEqual(busy.busyGroups, [4242]);
  assert.match(busy.reason, /used > 100 ms CPU/);
  assert.equal(classifyHostLoad({ psi: 1.2, builders: ['cargo'], groupCpuMs: { 1: 0 } }).underLoad, true, 'builder while pressure is at or above the 1.0 floor');
  const noise = classifyHostLoad({ psi: 0.03, builders: ['rustc'], groupCpuMs: { 2298217: 0 } });
  assert.equal(noise.underLoad, false, 'pressure 0.03 with an idle probe is noise (slot 97499baf)');
  assert.equal(noise.builderState, 'seen, idle');
  assert.equal(classifyHostLoad({ psi: 0.03, builders: ['rustc'], groupCpuMs: { 2601957: 400 } }).underLoad, true, '400 ms of builder CPU flags it even at low pressure');
  assert.equal(classifyHostLoad({ psi: 7, builders: [], groupCpuMs: {} }).underLoad, true, 'pressure >= 5 alone');
  assert.equal(classifyHostLoad({ psi: Number.NaN, builders: [] }).underLoad, true, 'unreadable pressure is never quiet');
});

test('settleHostLoad measures a process group\'s CPU over the sample from /proc', async () => {
  const { settleHostLoad } = await load('./load-scoreboard.mjs');
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const pgid = Number(f[2]);
  const ticks = () => { const s = readFileSync('/proc/self/stat', 'utf8'); const g = s.slice(s.lastIndexOf(')') + 2).split(' '); return Number(g[11]) + Number(g[12]); };
  // This process's own ticks before the burn: a lower bound of its group's total, so the measured use is >= the burn.
  const host = { cpuPressureAvg10: 0, limit: 5, builders: ['rustc'], builderProcs: [{ pgid }], groupTicksBefore: { [pgid]: ticks() }, settled: false };
  const end = Date.now() + 400; while (Date.now() < end) { /* burn ~400 ms CPU */ }
  settleHostLoad(host);
  assert.ok(host.groupCpuMs[pgid] >= 200, `group used ${host.groupCpuMs[pgid]} ms`);
  assert.equal(host.underLoad, true);
  assert.equal(host.settled, true);
  const again = host.groupCpuMs[pgid];
  settleHostLoad(host);
  assert.equal(host.groupCpuMs[pgid], again, 'settles once; rows of one sample share it');
});
