/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Host load around each scoreboard sample (H9): CPU pressure before it, and builder-named processes
 * with the CPU their process groups used during it. A process name alone is not load (see classifyHostLoad).
 */

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

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
 * Whether a sample was taken under load. A builder-named process alone is not load: short-lived toolchain probes
 * (`rustc -vV` from cargo metadata, rustup, rust-analyzer) show up with no CPU use and no pressure (metadata lane,
 * job a8faf2a6: 12 of 120 samples voided that way). Load = CPU pressure at or above `limit` after the wait, or a
 * builder's process group using more than `cpuMsLimit` of CPU during the sample, or any builder while pressure
 * was non-zero. A builder seen with neither is `seen, idle`: recorded, never voiding the cell.
 */
export function classifyHostLoad({ psi, limit = 5, builders = [], groupCpuMs = {}, cpuMsLimit = 100 }) {
  const pressure = !(psi < limit);
  const busyGroups = Object.entries(groupCpuMs).filter(([, ms]) => ms > cpuMsLimit).map(([g]) => Number(g));
  const builderUnderPressure = builders.length > 0 && !(psi === 0);
  const underLoad = pressure || busyGroups.length > 0 || builderUnderPressure;
  const builderState = builders.length === 0 ? 'none' : underLoad ? 'busy' : 'seen, idle';
  return { underLoad, builderState, busyGroups,
    reason: pressure ? `CPU pressure avg10 ${psi} >= ${limit}` : busyGroups.length ? `builder group(s) ${busyGroups.join(',')} used > ${cpuMsLimit} ms CPU during the sample`
      : builderUnderPressure ? `builder present while CPU pressure avg10 = ${psi}` : null };
}

/** H9: before each sample, wait (at most 20 s) for CPU pressure avg10 < 5, and note builder-named processes. */
export async function hostQuiet({ limit = 5, maxWaitMs = 20000 } = {}) {
  const started = Date.now();
  let psi = cpuPressure10();
  while (!(psi < limit) && Date.now() - started < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 1000));
    psi = cpuPressure10();
  }
  const procs = foreignBuilders();
  const pgids = [...new Set(procs.map((p) => p.pgid))];
  return { cpuPressureAvg10: psi, limit, waitedMs: Date.now() - started, builders: procs.map((p) => p.name), builderProcs: procs,
    groupTicksBefore: groupTicks(pgids), settled: false,
    // Provisional until the sample ends (settleHostLoad): pressure alone decides now.
    ...classifyHostLoad({ psi, limit, builders: procs.map((p) => p.name) }) };
}

/** After the sample: CPU each builder group used during it decides the flag (once per sample; rows share the object). */
export function settleHostLoad(host) {
  if (!host || host.settled || !Array.isArray(host.builderProcs)) return host;
  const after = groupTicks(Object.keys(host.groupTicksBefore ?? {}).map(Number));
  const groupCpuMs = {};
  for (const [g, before] of Object.entries(host.groupTicksBefore ?? {})) groupCpuMs[g] = Math.max(0, ((after[g] ?? before) - before) * TICK_MS);
  Object.assign(host, { groupCpuMs, settled: true, ...classifyHostLoad({ psi: host.cpuPressureAvg10, limit: host.limit, builders: host.builders, groupCpuMs }) });
  delete host.groupTicksBefore;
  return host;
}
