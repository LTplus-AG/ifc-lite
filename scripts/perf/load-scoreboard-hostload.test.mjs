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
  assert.deepEqual(busy.busyGroups, ['4242']);
  assert.match(busy.reason, /used > 100 ms CPU/);
  assert.equal(classifyHostLoad({ psi: 1.2, builders: ['cargo'], groupCpuMs: { 1: 0 } }).underLoad, true, 'builder while pressure is at or above the 1.0 floor');
  const noise = classifyHostLoad({ psi: 0.03, builders: ['rustc'], groupCpuMs: { 2298217: 0 } });
  assert.equal(noise.underLoad, false, 'pressure 0.03 with an idle probe is noise (slot 97499baf)');
  assert.equal(noise.builderState, 'seen, idle');
  assert.equal(classifyHostLoad({ psi: 0.03, builders: ['rustc'], groupCpuMs: { 2601957: 400 } }).underLoad, true, '400 ms of builder CPU flags it even at low pressure');
  assert.equal(classifyHostLoad({ psi: 7, builders: [], groupCpuMs: {} }).underLoad, true, 'pressure >= 5 alone');
  assert.equal(classifyHostLoad({ psi: Number.NaN, builders: [] }).underLoad, true, 'unreadable pressure is never quiet');
});

test('settleHostLoad charges a builder cgroup the CPU it used during the sample, from cpu.stat (survives exits)', async () => {
  const { settleHostLoad } = await load('./load-scoreboard.mjs');
  const rel = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'))?.slice(3);
  let usage = null;
  try { usage = Number(/usage_usec (\d+)/.exec(readFileSync(`/sys/fs/cgroup${rel}/cpu.stat`, 'utf8'))[1]) / 1000; } catch { /* no cgroup v2 here */ }
  if (usage === null) return; // nothing to measure on this host
  // Stand in for a foreign builder's cgroup with ours: its total before the burn, then 400 ms of CPU.
  const host = { cpuPressureAvg10: 0, limit: 5, builders: ['rustc'], builderProcs: [{}], groupTicksBefore: {}, cgroupUsageBefore: { [rel]: usage }, settled: false, startedAt: Date.now() };
  const end = Date.now() + 400; while (Date.now() < end) { /* burn ~400 ms CPU */ }
  settleHostLoad(host);
  assert.ok(host.builderCpuMs[rel] >= 200, `cgroup used ${host.builderCpuMs[rel]} ms`);
  assert.equal(host.underLoad, true);
  const again = host.builderCpuMs[rel];
  settleHostLoad(host);
  assert.equal(host.builderCpuMs[rel], again, 'settles once');
});

test('a builder whose cgroup is gone by the end of the sample is busy, never idle (review #9857)', async () => {
  const { settleHostLoad, classifyHostLoad } = await load('./load-scoreboard.mjs');
  const host = { cpuPressureAvg10: 0, limit: 5, builders: ['rustc'], builderProcs: [{}], groupTicksBefore: {}, cgroupUsageBefore: { '/no/such/cgroup.service': 1234 }, settled: false, startedAt: Date.now() };
  settleHostLoad(host);
  assert.equal(host.builderCpuMs['/no/such/cgroup.service'], null);
  assert.equal(host.underLoad, true);
  assert.match(host.reason, /gone before the sample ended: CPU unknown/);
  assert.equal(classifyHostLoad({ psi: 0, builders: ['rustc'], groupCpuMs: { '(no cgroup)': null } }).underLoad, true, 'an unmeasurable builder is busy');
});

test('a sample overlaps a watchdog pass when one ran at either end or one started in between; unknown is null', async () => {
  const { overlapsWatchdog } = await load('./load-scoreboard-host.mjs');
  const idle = (t) => ({ running: false, lastTriggerUs: t });
  assert.equal(overlapsWatchdog(idle(100), idle(100)), false, 'no pass during the sample');
  assert.equal(overlapsWatchdog({ running: true, lastTriggerUs: 100 }, idle(100)), true, 'running at the start');
  assert.equal(overlapsWatchdog(idle(100), { running: true, lastTriggerUs: 700 }), true, 'running at the end');
  assert.equal(overlapsWatchdog(idle(100), idle(700)), true, 'a whole pass started and ended inside the sample');
  assert.equal(overlapsWatchdog(null, idle(100)), null, 'unreadable state is unknown, never "no overlap"');
});

test('the report names cells with samples that overlapped a watchdog pass', async () => {
  const { watchdogRows } = await load('./load-scoreboard-report.mjs');
  const row = (side, over, foreign) => ({ ok: true, fixture: 'Holter', lane: 'browser-cold', side, host: { overlapsWatchdogPass: over, foreignCpuMs: foreign } });
  const rows = watchdogRows([row('base', true, 9000), row('base', false, 300), row('base', false, 500), row('branch', false, 400)]);
  assert.equal(rows.length, 1, 'a cell with no overlapping sample is not listed');
  assert.match(rows[0], /\| Holter \| browser-cold \| base \| 3 \| 1 \| 0 \| 9000 \|/, 'the median is over the overlapping sample only (review #9857)');
});
