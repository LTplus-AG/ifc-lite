/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Host load around each scoreboard sample (H9): CPU pressure before it, and builder-named processes
 * with the CPU their process groups used during it. A process name alone is not load (see classifyHostLoad).
 */

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function readText(path) { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } }

const BUILDERS = new Set(['cargo', 'rustc', 'rust-lld', 'cc1', 'cc1plus', 'wasm-opt', 'wasm-pack', 'turbo', 'pnpm', 'tsc']);
function cpuPressure10() { return Number(/some avg10=([\d.]+)/.exec(readText('/proc/pressure/cpu') ?? '')?.[1] ?? NaN); }
/** /proc facts about one builder-named process: who started it, where, and its CPU ticks so far (null when it is gone). */
function procInfo(pid) {
  const stat = readText(`/proc/${pid}/stat`);
  if (!stat) return null;
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // fields after "pid (comm) ": state ppid pgrp ... utime(12) stime(13)
  let cwd = null;
  try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* another user's process, or gone */ }
  return { pid: Number(pid), ppid: Number(f[1]), pgid: Number(f[2]), cpuTicks: Number(f[11]) + Number(f[12]),
    cwd, cgroup: readText(`/proc/${pid}/cgroup`)?.split('\n')[0] ?? null };
}
function foreignBuilders() {
  const out = [];
  for (const pid of readdirSync('/proc').filter((e) => /^\d+$/.test(e))) {
    const name = readText(`/proc/${pid}/comm`);
    if (name && BUILDERS.has(name)) { const info = procInfo(pid); if (info) out.push({ name, ...info }); }
  }
  return out;
}
/** CPU ticks per process group, for the groups seen holding a builder before the sample (every member counts). */
function groupTicks(pgids) {
  const want = new Set(pgids), ticks = {};
  if (want.size === 0) return ticks;
  for (const pid of readdirSync('/proc').filter((e) => /^\d+$/.test(e))) {
    const info = procInfo(pid);
    if (info && want.has(info.pgid)) ticks[info.pgid] = (ticks[info.pgid] ?? 0) + info.cpuTicks;
  }
  return ticks;
}
const TICK_MS = 10; // USER_HZ = 100 on Linux

/**
 * A periodic host job the scoreboard cannot stop (Pop: `fleet-night-watch`, a pass every 10 min that walks hundreds of
 * checkouts while free space is low, slowing overlapping samples' worker stages; B3 slot A, reopen run4). Its state,
 * read via `systemctl --user show` (unit from LOAD_SCOREBOARD_WATCH_UNIT, default fleet-night-watch): whether a pass
 * runs now, and the wall-clock time of the timer's last trigger (µs since the epoch). Null when it cannot be read.
 */
export function watchdogState(unit = process.env.LOAD_SCOREBOARD_WATCH_UNIT ?? 'fleet-night-watch') {
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}` };
  const show = (u, prop) => {
    const r = spawnSync('systemctl', ['--user', 'show', u, '-p', prop, '--value'], { env, encoding: 'utf8', timeout: 2000 });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const active = show(`${unit}.service`, 'ActiveState');
  // LastTriggerUSec is a wall-clock string ("Thu 2026-11-12 18:35:27 CET"); `date -d` reads it, abbreviation included.
  const lastText = show(`${unit}.timer`, 'LastTriggerUSec');
  if (active === null || active === '' || lastText === null) return null;
  const epoch = spawnSync('date', ['-d', lastText, '+%s'], { encoding: 'utf8', timeout: 2000 });
  const last = epoch.status === 0 && /^\d+$/.test(epoch.stdout.trim()) ? Number(epoch.stdout.trim()) : null;
  return { running: !['inactive', 'failed'].includes(active), lastTriggerUs: last === null ? null : last * 1e6 };
}

/** Whether a sample overlapped a watchdog pass: one ran at its start or end, or one started in between. Null when unknown. */
export function overlapsWatchdog(before, after) {
  if (!before || !after) return null;
  return before.running || after.running || (before.lastTriggerUs !== null && after.lastTriggerUs !== null && after.lastTriggerUs !== before.lastTriggerUs);
}

/** Busy CPU ms of the whole host so far (/proc/stat "cpu" line: all but idle and iowait), or null. */
function hostBusyMs() {
  const f = /^cpu\s+(.+)$/m.exec(readText('/proc/stat') ?? '')?.[1]?.split(/\s+/).map(Number);
  if (!f || f.some((x) => !Number.isFinite(x))) return null;
  const [user, nice, system, , , irq, softirq, steal] = f; // idle (3) and iowait (4) are not busy
  return (user + nice + system + irq + softirq + (steal ?? 0)) * TICK_MS;
}
/** Our own cgroup path ("/user.slice/...") and process group: a builder there is ours (Chrome, the harness), never foreign. */
function ownCgroupPath() { return readText('/proc/self/cgroup')?.split('\n').find((l) => l.startsWith('0::'))?.slice(3) ?? null; }
function ownPgid() { const st = readText('/proc/self/stat'); return st ? Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[2]) : null; }
/** CPU ms a cgroup used so far (cpu.stat usage_usec; survives its processes exiting), or null when the cgroup is gone. */
function cgroupUsageMs(path) {
  const usec = Number(/usage_usec (\d+)/.exec(readText(`/sys/fs/cgroup${path}/cpu.stat`) ?? '')?.[1]);
  return Number.isFinite(usec) ? usec / 1000 : null;
}

/** CPU ms this process's own cgroup (the benchmark job: harness, browsers, servers) used so far, or null. */
function ownCgroupMs() {
  const rel = readText('/proc/self/cgroup')?.split('\n').find((l) => l.startsWith('0::'))?.slice(3);
  const usec = rel ? Number(/usage_usec (\d+)/.exec(readText(`/sys/fs/cgroup${rel}/cpu.stat`) ?? '')?.[1]) : NaN;
  return Number.isFinite(usec) ? usec / 1000 : null;
}

/**
 * Whether a sample was taken under load. A builder-named process alone is not load: short-lived toolchain probes
 * (`rustc -vV` from cargo metadata, rustup, rust-analyzer) show up with no CPU use and no pressure (metadata lane,
 * job a8faf2a6: 12 of 120 samples voided that way). Load = CPU pressure at or above `limit` after the wait, or a
 * builder's process group using more than `cpuMsLimit` of CPU during the sample, or any builder while pressure
 * was at or above `pressureFloor` (1.0). A builder seen with neither is `seen, idle`: recorded, never voiding the cell.
 */
// `psi` everywhere here is the `some avg10` figure of /proc/pressure/cpu (share of the last 10 s in which at least
// one runnable task waited for a CPU, in percent), read just before the sample.
export function classifyHostLoad({ psi, limit = 5, builders = [], groupCpuMs = {}, cpuMsLimit = 100, pressureFloor = 1.0 }) {
  const pressure = !(psi < limit);
  // A builder whose CPU could not be measured (its cgroup is gone) is never idle (review #9857).
  const busyGroups = Object.entries(groupCpuMs).filter(([, ms]) => ms === null || ms > cpuMsLimit).map(([g]) => g);
  const unknownCpu = Object.values(groupCpuMs).some((ms) => ms === null);
  // Below the floor, pressure is noise (0.03 seen in slot 97499baf with an idle toolchain probe); unreadable pressure is never quiet.
  const builderUnderPressure = builders.length > 0 && !(psi < pressureFloor);
  const underLoad = pressure || busyGroups.length > 0 || builderUnderPressure;
  const builderState = builders.length === 0 ? 'none' : underLoad ? 'busy' : 'seen, idle';
  return { underLoad, builderState, busyGroups,
    reason: pressure ? `CPU pressure avg10 ${psi} >= ${limit}` : busyGroups.length ? (unknownCpu ? `builder cgroup(s) ${busyGroups.join(',')} gone before the sample ended: CPU unknown` : `builder cgroup(s) ${busyGroups.join(',')} used > ${cpuMsLimit} ms CPU during the sample`)
      : builderUnderPressure ? `builder present while CPU pressure some avg10 = ${psi} >= ${pressureFloor}` : null };
}

/**
 * Measurement only: CPU package temperature (coretemp "Package id 0", deg C) and the kernel's package thermal
 * throttle counters (cpu0/thermal_throttle: events and total ms). Pop ran at 91-94 C on 2026-11-12, so a throttled
 * sample must be visible. Every value is null when unreadable; nothing is voided by it.
 */
export function thermalState(root = '/sys') {
  const num = (path, scale = 1) => { try { const v = Number(readFileSync(path, 'utf8').trim()); return Number.isFinite(v) ? v / scale : null; } catch { return null; } };
  let packageC = null;
  try {
    for (const hw of readdirSync(`${root}/class/hwmon`)) {
      const dir = `${root}/class/hwmon/${hw}`;
      let name = null; try { name = readFileSync(`${dir}/name`, 'utf8').trim(); } catch { continue; }
      if (name !== 'coretemp') continue;
      for (const f of readdirSync(dir).filter((x) => /^temp\d+_label$/.test(x))) {
        if (readFileSync(`${dir}/${f}`, 'utf8').trim() === 'Package id 0') packageC = num(`${dir}/${f.replace('_label', '_input')}`, 1000);
      }
    }
  } catch { /* no hwmon */ }
  const t = `${root}/devices/system/cpu/cpu0/thermal_throttle`;
  return { packageC, packageThrottleCount: num(`${t}/package_throttle_count`), packageThrottleMs: num(`${t}/package_throttle_total_time_ms`) };
}

/** Start/end package temperature and the package throttling during a sample; a counter missing on either side is null. */
export function thermalDelta(before, after) {
  const d = (k) => (Number.isFinite(before?.[k]) && Number.isFinite(after?.[k]) ? Math.max(0, after[k] - before[k]) : null);
  return { startC: before?.packageC ?? null, endC: after?.packageC ?? null, throttleEvents: d('packageThrottleCount'), throttleMs: d('packageThrottleMs') };
}

/** H9: before each sample, wait (at most 20 s) for CPU pressure avg10 < 5, and note builder-named processes. */
export async function hostQuiet({ limit = 5, maxWaitMs = 20000 } = {}) {
  const started = Date.now();
  let psi = cpuPressure10();
  while (!(psi < limit) && Date.now() - started < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 1000));
    psi = cpuPressure10();
  }
  const own = ownCgroupPath(), pgid = ownPgid();
  // Builders in our own cgroup or process group are our children, not foreign load (review #9857).
  const procs = foreignBuilders().filter((p) => p.pgid !== pgid && (p.cgroup ?? '').slice(3) !== own);
  const pgids = [...new Set(procs.map((p) => p.pgid))];
  const cgroups = [...new Set(procs.map((p) => (p.cgroup ?? '').slice(3)).filter(Boolean))];
  return { cpuPressureAvg10: psi, limit, waitedMs: Date.now() - started, builders: procs.map((p) => p.name), builderProcs: procs,
    groupTicksBefore: groupTicks(pgids), cgroupUsageBefore: { ...Object.fromEntries(cgroups.map((c) => [c, cgroupUsageMs(c)])), ...(procs.some((p) => !p.cgroup) ? { '(no cgroup)': null } : {}) }, hostBusyBefore: hostBusyMs(), ownCgroupBefore: ownCgroupMs(), watchdogBefore: watchdogState(), thermalBefore: thermalState(), settledAt: null, startedAt: Date.now(), settled: false,
    // Provisional until the sample ends (settleHostLoad): pressure alone decides now.
    ...classifyHostLoad({ psi, limit, builders: procs.map((p) => p.name) }) };
}

/** After the sample: CPU each builder group used during it decides the flag (once per sample; rows share the object). */
export function settleHostLoad(host) {
  if (!host || host.settled || !Array.isArray(host.builderProcs)) return host;
  const after = groupTicks(Object.keys(host.groupTicksBefore ?? {}).map(Number));
  const groupCpuMs = {};
  for (const [g, before] of Object.entries(host.groupTicksBefore ?? {})) groupCpuMs[g] = Math.max(0, ((after[g] ?? before) - before) * TICK_MS);
  // Measurement only (not a flag yet): CPU the rest of the host used during the sample, whatever its process names,
  // = host busy time minus this job's own cgroup. Recorded so a threshold can be set from real slots (B3: bursts
  // of foreign activity every ~10 min slowed samples with no builder visible at their start).
  const busy = hostBusyMs(), own = ownCgroupMs();
  const foreignCpuMs = [busy, own, host.hostBusyBefore, host.ownCgroupBefore].every(Number.isFinite)
    ? Math.max(0, Math.round((busy - host.hostBusyBefore) - (own - host.ownCgroupBefore))) : null;
  const sampleMs = Date.now() - host.startedAt;
  // Measurement only: affected cells are visible, nothing is voided by it.
  const overlapsWatchdogPass = overlapsWatchdog(host.watchdogBefore, watchdogState());
  // The decision uses cgroup totals (process counters vanish when a builder exits before the sample ends).
  const builderCpuMs = {};
  for (const [c, before] of Object.entries(host.cgroupUsageBefore ?? {})) {
    const after = cgroupUsageMs(c);
    builderCpuMs[c] = before === null || after === null ? null : Math.max(0, Math.round(after - before));
  }
  const thermal = thermalDelta(host.thermalBefore, thermalState());
  Object.assign(host, { groupCpuMs, builderCpuMs, foreignCpuMs, sampleMs, overlapsWatchdogPass, thermal, settled: true, ...classifyHostLoad({ psi: host.cpuPressureAvg10, limit: host.limit, builders: host.builders, groupCpuMs: builderCpuMs }) });
  delete host.groupTicksBefore; delete host.cgroupUsageBefore; delete host.hostBusyBefore; delete host.ownCgroupBefore; delete host.watchdogBefore; delete host.thermalBefore;
  return host;
}
