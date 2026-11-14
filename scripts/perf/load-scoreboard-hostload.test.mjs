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

test('settleHostLoad charges a builder cgroup the CPU it used during the sample, from cpu.stat (survives exits)', async (t) => {
  const { settleHostLoad } = await load('./load-scoreboard.mjs');
  // @source-text-assertion-ok reads this process's live cgroup (runtime state), not source text
  const rel = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'))?.slice(3);
  let usage = null;
  // @source-text-assertion-ok reads the live cgroup cpu.stat counter (runtime state), not source text
  try { usage = Number(/usage_usec (\d+)/.exec(readFileSync(`/sys/fs/cgroup${rel}/cpu.stat`, 'utf8'))[1]) / 1000; } catch { /* no cgroup v2 here */ }
  // A host without cgroup v2 reports this test as skipped, never as a pass that asserted nothing (review #9952).
  if (usage === null) { t.skip('no readable cgroup v2 cpu.stat on this host'); return; }
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
  // @source-text-assertion-ok asserts on the sampler's reason string (behaviour output), not source text
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
  assert.equal(overlapsWatchdog(idle(100), idle(null)), null, 'an unreadable trigger time is unknown, never "no overlap" (review #9952)');
  assert.equal(overlapsWatchdog(idle(null), { running: true, lastTriggerUs: null }), true, 'a pass seen running still counts');
});

test('the report names cells with samples that overlapped a watchdog pass', async () => {
  const { watchdogRows } = await load('./load-scoreboard-report.mjs');
  const row = (side, over, foreign) => ({ ok: true, fixture: 'Holter', lane: 'browser-cold', side, host: { overlapsWatchdogPass: over, foreignCpuMs: foreign } });
  const rows = watchdogRows([row('base', true, 9000), row('base', false, 300), row('base', false, 500), row('branch', false, 400)]);
  assert.equal(rows.length, 1, 'a cell with no overlapping sample is not listed');
  assert.match(rows[0], /\| Holter \| browser-cold \| base \| 3 \| 1 \| 0 \| 9000 \|/, 'the median is over the overlapping sample only (review #9857)');
});

test('a sample records package temperature at both ends and the package throttling during it; unreadable is null', async () => {
  const { thermalState, thermalDelta } = await load('./load-scoreboard-host.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'thermal-'));
  const hw = join(root, 'class/hwmon/hwmon9'), tt = join(root, 'devices/system/cpu/cpu0/thermal_throttle');
  mkdirSync(hw, { recursive: true }); mkdirSync(tt, { recursive: true });
  writeFileSync(join(hw, 'name'), 'coretemp\n'); writeFileSync(join(hw, 'temp1_label'), 'Package id 0\n'); writeFileSync(join(hw, 'temp1_input'), '91000\n');
  writeFileSync(join(hw, 'temp2_label'), 'Core 0\n'); writeFileSync(join(hw, 'temp2_input'), '70000\n');
  writeFileSync(join(tt, 'package_throttle_count'), '100\n'); writeFileSync(join(tt, 'package_throttle_total_time_ms'), '5000\n');
  const before = thermalState(root);
  assert.deepEqual(before, { packageC: 91, packageThrottleCount: 100, packageThrottleMs: 5000 });
  writeFileSync(join(hw, 'temp1_input'), '94000\n'); writeFileSync(join(tt, 'package_throttle_count'), '103\n'); writeFileSync(join(tt, 'package_throttle_total_time_ms'), '5250\n');
  assert.deepEqual(thermalDelta(before, thermalState(root)), { startC: 91, endC: 94, throttleEvents: 3, throttleMs: 250 });
  // No sensors at all: every value null, never 0 C or "no throttling".
  // A blank sensor file is unreadable, not 0 C or zero throttle events (review #9952).
  writeFileSync(join(hw, 'temp1_input'), '  \n'); writeFileSync(join(tt, 'package_throttle_count'), '');
  assert.deepEqual(thermalState(root), { packageC: null, packageThrottleCount: null, packageThrottleMs: 5250 });
  // Two sockets, each with its own coretemp device and package: the hottest package, counters summed per package (review #9952).
  const two = mkdtempSync(join(tmpdir(), 'thermal2-'));
  for (const [hwn, c] of [['hwmon1', '70000'], ['hwmon2', '88000']]) {
    const d = join(two, 'class/hwmon', hwn); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'name'), 'coretemp\n'); writeFileSync(join(d, 'temp1_label'), 'Package id 0\n'); writeFileSync(join(d, 'temp1_input'), `${c}\n`);
  }
  for (const [cpu, pkg, n, ms] of [['cpu0', 0, 5, 100], ['cpu1', 0, 5, 100], ['cpu2', 1, 7, 300]]) {
    const d = join(two, 'devices/system/cpu', cpu); mkdirSync(join(d, 'thermal_throttle'), { recursive: true }); mkdirSync(join(d, 'topology'), { recursive: true });
    writeFileSync(join(d, 'topology/physical_package_id'), `${pkg}\n`);
    writeFileSync(join(d, 'thermal_throttle/package_throttle_count'), `${n}\n`); writeFileSync(join(d, 'thermal_throttle/package_throttle_total_time_ms'), `${ms}\n`);
  }
  assert.deepEqual(thermalState(two), { packageC: 88, packageThrottleCount: 12, packageThrottleMs: 400 });
  const none = thermalState(join(root, 'missing'));
  assert.deepEqual(none, { packageC: null, packageThrottleCount: null, packageThrottleMs: null });
  assert.deepEqual(thermalDelta(none, before), { startC: null, endC: 91, throttleEvents: null, throttleMs: null });
});

test('the report names cells with throttled or unreadable-thermal samples and their hottest reading; quiet cells are omitted', async () => {
  const { thermalRows } = await load('./load-scoreboard-report-sections.mjs');
  const row = (fixture, side, thermal) => ({ ok: true, fixture, lane: 'browser-cold', side, host: { thermal } });
  const rows = thermalRows([
    row('Holter', 'base', { startC: 91, endC: 94, throttleEvents: 3, throttleMs: 250 }),
    row('Holter', 'base', { startC: 88, endC: 90, throttleEvents: 0, throttleMs: 0 }),
    row('Holter', 'branch', { startC: null, endC: null, throttleEvents: null, throttleMs: null }),
    row('FZK', 'base', { startC: 80, endC: 81, throttleEvents: 0, throttleMs: 0 }),
  ]);
  assert.deepEqual(rows, ['| Holter | browser-cold | base | 2 | 1 | 2 | 0 | 250 | 94 |', '| Holter | browser-cold | branch | 1 | 0 | 0 | 1 | — | — |']);
  assert.deepEqual(thermalRows([{ ok: true, fixture: 'x', lane: 'browser-cold', side: 'base', host: {} }]), [], 'rows from a harness without the read are not reported');
  // Sustained throttling moves neither counter (count at onset, time at the end): a hot sample is listed, never quiet (review #9952).
  assert.deepEqual(thermalRows([row('Holter', 'base', { startC: 95, endC: 96, throttleEvents: 0, throttleMs: 0 })]), ['| Holter | browser-cold | base | 1 | 0 | 1 | 0 | 0 | 96 |']);
  // Throttling already active at the start adds time without a new event; one unreadable counter is unknown (review #9952).
  assert.deepEqual(thermalRows([row('BWK', 'base', { startC: 92, endC: 93, throttleEvents: 0, throttleMs: 250 })]), ['| BWK | browser-cold | base | 1 | 1 | 1 | 0 | 250 | 93 |']);
  assert.deepEqual(thermalRows([row('BWK', 'base', { startC: 80, endC: 80, throttleEvents: 0, throttleMs: null })]), ['| BWK | browser-cold | base | 1 | 0 | 0 | 1 | — | 80 |']);
});

test('the benchmark browser outside the job cgroup is the sample\'s own CPU, not foreign (Chromium moves itself into its own scope)', async () => {
  const { hostQuiet, settleHostLoad, outsideOwnCgroup } = await load('./load-scoreboard-host.mjs');
  // A process in our own cgroup is never counted as outside it.
  const mine = outsideOwnCgroup([process.pid]);
  assert.deepEqual([mine.cpuMs, mine.pressureUs, mine.scopes], [0, 0, 0]);
  const plain = settleHostLoad(await hostQuiet({ maxWaitMs: 0 }));
  const own = settleHostLoad(await hostQuiet({ maxWaitMs: 0 }), { ownOutside: { cpuMs: 1e9, pressureUs: 0 } });
  if (plain.foreignCpuMs !== null) {
    assert.equal(own.foreignCpuMs, 0); // subtracted (clamped at 0)
    assert.equal(own.ownOutsideCgroupCpuMs, 1e9);
    assert.equal(plain.ownOutsideCgroupCpuMs, null);
  }
});

test('the pre-sample wait override is bounded both ways: 0..600000 ms, anything else is the 20 s default', async () => {
  const { quietWaitMs } = await load('./load-scoreboard-host.mjs');
  const at = (v) => { if (v === undefined) delete process.env.LOAD_SCOREBOARD_QUIET_WAIT_MS; else process.env.LOAD_SCOREBOARD_QUIET_WAIT_MS = v; return quietWaitMs(); };
  try {
    assert.deepEqual(['0', '5000', '600000', 'Infinity', '1e309', '-1', '', 'abc', undefined].map(at), [0, 5000, 600000, 20000, 20000, 20000, 20000, 20000, 20000]);
  } finally { delete process.env.LOAD_SCOREBOARD_QUIET_WAIT_MS; }
});
