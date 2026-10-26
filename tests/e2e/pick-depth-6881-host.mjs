/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Host-quiet admission for the #6881 cohort that excludes the cohort's own
// process tree. The shared whole-host reading counts the benchmark's Chrome,
// GPU and viewer workers as interference, so the run could trip its own 10%
// limit (observed 10.2% and 10.7% with no foreign work). Whole-host busy CPU and
// the CPU used by the cohort's process tree are both measured here over one
// shared one-second window, so they subtract coherently. The shared admission
// reading still supplies every other condition (foreign build graphs, memory, AC
// power); its own CPU figure is kept for the record but is not used.
//
// Own CPU can be under-counted when a child exits mid-window, which can only
// reject a quiet host, never admit a busy one.
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export const MAXIMUM_FOREIGN_CPU_PERCENT = 10;

const cpuTimes = () => readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);

function processTable() {
  const table = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const text = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      table.set(Number(name), { parent: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]) });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return table;
}

// CPU ticks of root and every descendant, keyed by pid so exited processes drop out.
export function treeTicks(root, table = processTable()) {
  const members = new Map([[root, table.get(root)]]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, row] of table) if (!members.has(pid) && members.has(row.parent)) { members.set(pid, row); grew = true; }
  }
  return new Map([...members].filter(([, row]) => row).map(([pid, row]) => [pid, row.ticks]));
}

// Busy and own CPU over the same window: [busy] is 100 * (total - idle - iowait) / total.
export async function measureCpuWindow(root = process.pid, milliseconds = 1000) {
  const cpuBefore = cpuTimes(), ownBefore = treeTicks(root), startedAt = performance.now();
  await sleep(milliseconds);
  const cpuAfter = cpuTimes(), ownAfter = treeTicks(root), durationMs = performance.now() - startedAt;
  const delta = cpuAfter.map((value, index) => value - cpuBefore[index]);
  const total = delta.reduce((a, b) => a + b, 0);
  let own = 0;
  for (const [pid, ticks] of ownAfter) own += ticks - (ownBefore.get(pid) ?? 0);
  const busyCpuPercent = 100 * (total - delta[3] - delta[4]) / total, ownCpuPercent = 100 * Math.max(0, own) / total;
  return { busyCpuPercent, ownCpuPercent, foreignCpuPercent: Math.max(0, busyCpuPercent - ownCpuPercent), durationMs };
}

export async function readForeignHostAdmission(readHostAdmission, root = process.pid) {
  const [window, host] = await Promise.all([measureCpuWindow(root), readHostAdmission()]);
  const quiet = Number.isFinite(window.foreignCpuPercent) && window.foreignCpuPercent <= MAXIMUM_FOREIGN_CPU_PERCENT
    && host.MemAvailableKiB >= host.policy.minimumMemoryKiB && host.graphsBefore.length === 0 && host.graphsAfter.length === 0 && host.ac;
  return { ...host, sharedWindowCpuPercent: host.cpuPercent, cpuPercent: window.busyCpuPercent, rawQuiet: host.quiet, quiet,
    ownCpuPercent: window.ownCpuPercent, foreignCpuPercent: window.foreignCpuPercent, windowMs: window.durationMs };
}

// Brief host spikes (observed 11.3% for one window right after a sample's
// browser closed) refused whole cohorts on a single reading. Admission now
// repeats the one-second reading until one is quiet or the budget runs out, so
// sustained foreign work (builds, other benchmarks) is still refused while a
// transient spike only delays the sample. Only host readings are retried; no
// timing measurement is ever repeated or discarded. Every reading is kept.
export const QUIET_WAIT_BUDGET_MS = 60_000;

export async function awaitQuietHost(readHostAdmission, root = process.pid, budgetMs = QUIET_WAIT_BUDGET_MS) {
  const startedAt = Date.now(), attempts = [];
  for (;;) {
    const reading = await readForeignHostAdmission(readHostAdmission, root);
    attempts.push({ at: reading.capturedAt, quiet: reading.quiet, foreignCpuPercent: reading.foreignCpuPercent });
    if (reading.quiet || Date.now() - startedAt >= budgetMs) return { ...reading, attempts, waitedMs: Date.now() - startedAt };
  }
}
