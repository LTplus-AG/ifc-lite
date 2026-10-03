/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { processIdentity } from './interleaved-cleanup.mjs';
import { classifyBuildTestProcess } from './sdk-process-classification.mjs';
import { limits } from './sdk-plan.mjs';
export function available() {
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
  if (!match) throw new Error('Linux MemAvailable absent');
  return Number(match[1]) * 1024;
}
export function cpuReading(text, monotonicNs) {
  const match = /^cpu\s+((?:\d+\s+){7}\d+)/m.exec(text);
  if (!match) throw new Error('Linux aggregate CPU counters absent');
  const fields = match[1].trim().split(/\s+/).map(BigInt);
  return { capturedUTC: new Date().toISOString(), monotonicNs: String(monotonicNs), raw: match[0],
    total: String(fields.reduce((sum, value) => sum + value, 0n)), idle: String(fields[3] + fields[4]) };
}
export function cpuIntervals(rows) {
  if (rows.length !== 4) throw new Error('exactly four fresh Linux CPU readings required');
  return rows.slice(1).map((row, index) => {
    const prior = rows[index], ns = BigInt(row.monotonicNs) - BigInt(prior.monotonicNs);
    const total = BigInt(row.total) - BigInt(prior.total), idle = BigInt(row.idle) - BigInt(prior.idle);
    if (ns < 1000000000n || total <= 0n || total > BigInt(Number.MAX_SAFE_INTEGER) || idle < 0n || idle > total) throw new Error('CPU interval/counter provenance refused');
    const cpuPercent = 100 * (1 - Number(idle) / Number(total));
    return { startUTC: prior.capturedUTC, endUTC: row.capturedUTC, elapsedNs: String(ns), totalTicks: String(total), idleTicks: String(idle), cpuPercent, eligible: idle * 10n >= total * 9n };
  });
}
export function noBuildGraphs() {
  const active = [];
  for (const name of readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    try {
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      let executable;
      try { executable = readlinkSync(`/proc/${name}/exe`); }
      catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; executable = args[0] ?? ''; }
      const classification = classifyBuildTestProcess(args, executable);
      if (classification) active.push({ pid: Number(name), ...classification });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  if (active.length) throw new Error(`observable Linux build/test graphs: ${JSON.stringify(active)}`);
  return { capturedUTC: new Date().toISOString(), active };
}
export async function quiet() {
  const rows = [], before = noBuildGraphs();
  for (let index = 0; index < 4; index++) {
    if (index) await pause(1000);
    if (available() < limits.liveBytes) throw new Error('Linux4GiB live reserve refused');
    rows.push(cpuReading(readFileSync('/proc/stat', 'utf8'), process.hrtime.bigint()));
  }
  const intervals = cpuIntervals(rows), after = noBuildGraphs();
  const receipt = { before, after, rows, intervals, idleDefinition: 'idle+iowait; first8 aggregate counters, guest excluded to avoid double counting' };
  if (intervals.some(row => !row.eligible)) throw new Error(`Linux CPU <=10% admission refused: ${JSON.stringify(receipt)}`);
  return receipt;
}
export function ownedSnapshot(rootPid) {
  const identities = readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(processIdentity).filter(Boolean);
  const descendants = new Set([rootPid]);
  for (let depth = 0; depth < 32; depth++) {
    const before = descendants.size;
    for (const identity of identities) if (descendants.has(identity.ppid)) descendants.add(identity.pid);
    if (descendants.size === before) break;
    if (depth === 31) throw new Error('owned process depth bound');
  }
  if (descendants.size > 4096) throw new Error('owned process count bound');
  let bytes = 0;
  for (const identity of identities) if (descendants.has(identity.pid)) {
    try {
      if (processIdentity(identity.pid)?.startTime !== identity.startTime) continue;
      const rss = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${identity.pid}/status`, 'utf8'));
      if (rss) bytes += Number(rss[1]) * 1024;
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return { at: Date.now(), bytes, members: identities.filter(identity => descendants.has(identity.pid) && identity.pid !== rootPid) };
}
