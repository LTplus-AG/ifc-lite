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
// Timers may wake early. Acceptance depends on the measured monotonic interval,
// so keep waiting until the deadline instead of lowering the one-second floor.
export async function waitUntil(deadline, now = () => process.hrtime.bigint(), delay = pause) {
  let remaining;
  while ((remaining = deadline - now()) > 0n) {
    await delay(Number((remaining + 999999n) / 1000000n));
  }
}
function cpuRefusal(receipt, cause) {
  const evidence = { ...receipt, status: 'refused', reason: String(cause) };
  const error = new Error(`Linux CPU admission refused: ${JSON.stringify(evidence)}`, { cause });
  error.receipt = evidence;
  return error;
}
export function qualifyCPU(receipt) {
  try {
    receipt.intervals = cpuIntervals(receipt.rows);
    if (receipt.intervals.some(row => !row.eligible)) throw new Error('Linux CPU <=10% admission refused');
    return receipt;
  } catch (cause) {
    throw cpuRefusal(receipt, cause);
  }
}
// Permission-denied exe observations retain the process and its argv classifier.
// cmdline failures remain terminal; only disappearing process races return null.
export function processObservation(pid, { readFile = readFileSync, readLink = readlinkSync } = {}) {
  try {
    const argv = readFile(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    let executable, executableObserved = true, executableAccessError;
    try { executable = readLink(`/proc/${pid}/exe`); }
    catch (error) {
      if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
      executable = argv[0] ?? ''; executableObserved = false; executableAccessError = error.code;
    }
    return { pid: Number(pid), argv, executable, executableObserved, executableAccessError,
      classification: classifyBuildTestProcess(argv, executable) };
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
export function noBuildGraphs({ pids = readdirSync('/proc').filter(value => /^\d+$/.test(value)), observe = processObservation } = {}) {
  const active = [], permissionFallbacks = [];
  for (const pid of pids) {
    const record = observe(pid); if (!record) continue;
    const evidence = { pid: record.pid, executableObserved: record.executableObserved, executableAccessError: record.executableAccessError };
    if (!record.executableObserved) permissionFallbacks.push(evidence);
    if (record.classification) active.push({ ...evidence, ...record.classification });
  }
  if (active.length) throw new Error(`observable Linux build/test graphs: ${JSON.stringify(active)}`);
  return { capturedUTC: new Date().toISOString(), active, permissionFallbacks };
}
export async function quiet() {
  const receipt = { rows: [],
    idleDefinition: 'idle+iowait; first8 aggregate counters, guest excluded to avoid double counting' };
  try {
    receipt.before = noBuildGraphs();
    for (let index = 0; index < 4; index++) {
      if (index) await waitUntil(BigInt(receipt.rows.at(-1).monotonicNs) + 1000000000n);
      if (available() < limits.liveBytes) throw new Error('Linux4GiB live reserve refused');
      receipt.rows.push(cpuReading(readFileSync('/proc/stat', 'utf8'), process.hrtime.bigint()));
    }
    receipt.after = noBuildGraphs();
    return qualifyCPU(receipt);
  } catch (cause) {
    if (cause.receipt) throw cause;
    throw cpuRefusal(receipt, cause);
  }
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
