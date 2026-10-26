/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Host-quiet admission for the #6881 cohort that excludes the cohort's own
// process tree. The shared whole-host reading counts the benchmark's Chrome,
// GPU and viewer workers as interference, so the run could trip its own 10%
// limit (observed 10.2% and 10.7% with no foreign work). This subtracts the CPU
// that the cohort's process tree used over the same window and keeps every other
// admission condition (foreign build graphs, memory, AC power) unchanged.
import { readFileSync, readdirSync } from 'node:fs';

export const MAXIMUM_FOREIGN_CPU_PERCENT = 10;

const totalTicks = () => readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number).reduce((a, b) => a + b, 0);

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

export async function readForeignHostAdmission(readHostAdmission, root = process.pid) {
  const totalBefore = totalTicks(), ownBefore = treeTicks(root);
  const host = await readHostAdmission();
  const totalAfter = totalTicks(), ownAfter = treeTicks(root);
  let own = 0;
  for (const [pid, ticks] of ownAfter) own += ticks - (ownBefore.get(pid) ?? 0);
  const ownCpuPercent = 100 * Math.max(0, own) / (totalAfter - totalBefore);
  const foreignCpuPercent = Math.max(0, host.cpuPercent - ownCpuPercent);
  const quiet = Number.isFinite(foreignCpuPercent) && foreignCpuPercent <= MAXIMUM_FOREIGN_CPU_PERCENT
    && host.MemAvailableKiB >= host.policy.minimumMemoryKiB && host.graphsBefore.length === 0 && host.graphsAfter.length === 0 && host.ac;
  return { ...host, rawQuiet: host.quiet, quiet, ownCpuPercent, foreignCpuPercent };
}
