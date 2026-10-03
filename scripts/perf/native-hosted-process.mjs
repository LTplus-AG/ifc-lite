/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute } from 'node:path';
import { createWriteStream, readdirSync, readlinkSync } from 'node:fs';
import { fileHash } from './interleaved-assets.mjs';
import { processIdentity, finishLog, stopWitnessedProcesses } from './interleaved-cleanup.mjs';
import { available, ownedSnapshot, processObservation } from './sdk-resources.mjs';
import { cargoArgs, freshnessException, freshnessPredicates, refreshedCargoWitness, limits } from './native-hosted-plan.mjs';
export function compilerEnvironment(environment, tools) {
  if (!tools) return environment;
  if (![tools.cargo, tools.rustc, tools.rustdoc].every(path => typeof path === 'string' && isAbsolute(path))
    || dirname(tools.cargo) !== dirname(tools.rustc) || dirname(tools.cargo) !== dirname(tools.rustdoc)
    || basename(dirname(dirname(tools.rustc))) !== tools.toolchain
    || typeof tools.toolchain !== 'string' || !/^nightly-\d{4}-\d{2}-\d{2}-[a-z0-9_-]+$/.test(tools.toolchain)) {
    throw new Error('native compiler selection refused');
  }
  return { ...environment, RUSTC: tools.rustc, RUSTDOC: tools.rustdoc, RUSTUP_TOOLCHAIN: tools.toolchain };
}
function graphScan(witnesses, expected) {
  const exceptions = [], permissionFallbacks = [], witnessRefreshes = []; let freshSnapshot;
  for (const name of readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    try {
      const observed = processObservation(name); if (!observed) continue;
      const { classification } = observed;
      if (!observed.executableObserved) permissionFallbacks.push({ pid: observed.pid, executableObserved: false, executableAccessError: observed.executableAccessError });
      if (!classification) continue;
      const identity = processIdentity(name); if (!identity) continue;
      const record = { ...identity, ...observed, cwd: readlinkSync(`/proc/${name}/cwd`) };
      if (!witnesses.has(record.pid) && freshnessException(record, record, expected)) {
        freshSnapshot ??= ownedSnapshot(process.pid); // At most one bounded fresh own-ancestry census per scan.
        const currentObserved = processObservation(name), currentIdentity = processIdentity(name);
        const current = currentObserved && currentIdentity ? { ...currentIdentity, ...currentObserved, cwd: readlinkSync(`/proc/${name}/cwd`) } : null;
        const refreshed = refreshedCargoWitness(record, expected, freshSnapshot, current);
        if (refreshed) {
          witnesses.set(refreshed.pid, refreshed);
          witnessRefreshes.push({ ...refreshed, source: 'fresh-own-ancestry-census-plus-current-observation', capturedAt: freshSnapshot.at,
            censusMembers: freshSnapshot.members.length, depthBound: 32, processBound: 4096 });
        }
      }
      const witness = witnesses.get(record.pid);
      if (!freshnessException(record, witness, expected)) {
        const details = { actual: record, expected: { ...expected, argv: ['cargo', ...cargoArgs] },
          witness: witness ?? null, predicates: freshnessPredicates(record, witness, expected) };
        const error = new Error(`non-exempt compiler/test graph: ${JSON.stringify(details)}`);
        error.freshnessRefusal = details;
        throw error;
      }
      exceptions.push({ ...identity, classification, executable: record.executable, executableObserved: true, cwd: record.cwd });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return { exceptions, permissionFallbacks, witnessRefreshes };
}
export async function execute(command, directory, prefix, { sample = false, tools, wallMs = 180000 } = {}) {
  const executable = tools && ['bash', 'cargo'].includes(command[0]) ? tools[command[0]] : command[0];
  const paths = { stdout: `${prefix}.stdout`, stderr: `${prefix}.stderr` };
  const logs = Object.values(paths).map(path => createWriteStream(path, { flags: 'wx' }));
  const row = { status: 'pending', command, executable, directory, paths, startedUTC: new Date().toISOString(), samples: [], cargoExceptions: [], permissionFallbacks: [], witnessRefreshes: [],
    compilerSelection: tools ? { rustc: tools.rustc, rustdoc: tools.rustdoc, toolchain: tools.toolchain } : undefined };
  const witnesses = new Map(); let child, refusal, monitor, deadline, pipeDeadline, settle, exit, abortCleanup;
  const abort = reason => {
    refusal ??= String(reason);
    if (reason?.freshnessRefusal && !row.freshnessRefusal) row.freshnessRefusal = reason.freshnessRefusal;
    const witness = witnesses.get(child?.pid), current = child?.pid && processIdentity(child.pid);
    if (witness && current?.startTime === witness.startTime && current.pgrp === child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') refusal += `; ${error}`; }
    }
    abortCleanup ??= stopWitnessedProcesses([...witnesses.values()], 30000);
    pipeDeadline ??= setTimeout(() => { row.pipeTailCertified = false; child?.stdout.destroy(); child?.stderr.destroy(); child?.unref(); settle?.({ code: null }); }, 30000);
  };
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => abort(`received ${signal}`)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  for (const log of logs) log.on('error', error => abort(`log write: ${error}`));
  try {
    child = spawn(executable, command.slice(1), { cwd: directory, detached: true,
      env: compilerEnvironment({ ...process.env, OBS: '0', CARGO_BUILD_JOBS: '1', CARGO_TERM_COLOR: 'never' }, tools), stdio: ['ignore', 'pipe', 'pipe'] });
    const identity = processIdentity(child.pid); if (!identity) throw new Error('child PID witness absent'); witnesses.set(identity.pid, identity);
    let bytes = 0;
    [child.stdout, child.stderr].forEach((stream, index) => {
      stream.on('data', data => { bytes += data.length; if (bytes > 16 * 1024 ** 2) abort('native raw log 16MiB bound'); }); stream.pipe(logs[index], { end: false });
    });
    const observe = () => {
      try {
        const snapshot = ownedSnapshot(process.pid);
        for (const item of snapshot.members) witnesses.set(item.pid, item);
        if (row.samples.length >= 100000) throw new Error('native observation bound');
        row.samples.push({ at: snapshot.at, bytes: snapshot.bytes });
        if (snapshot.bytes > limits.rssBytes || available() < limits.liveBytes) throw new Error('native ownedRSS/live reserve refused');
        if (sample) {
          const scan = graphScan(witnesses, { ...tools, directory, group: child.pid });
          for (const [key, rows] of [['cargoExceptions', scan.exceptions], ['permissionFallbacks', scan.permissionFallbacks], ['witnessRefreshes', scan.witnessRefreshes]]) {
            for (const item of rows) if (!row[key].some(prior => prior.pid === item.pid && prior.startTime === item.startTime)) {
              if (row[key].length >= 4096) throw new Error('native process observation evidence bound');
              row[key].push(item);
            }
          }
        }
      } catch (error) { abort(error); }
    };
    monitor = setInterval(observe, 250); observe(); deadline = setTimeout(() => abort('native child wall bound'), wallMs);
    exit = await new Promise((accept, reject) => { settle = accept; child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })); });
  } catch (error) { abort(error); }
  finally {
    clearInterval(monitor); clearTimeout(deadline); clearTimeout(pipeDeadline);
    row.cleanup = await stopWitnessedProcesses([...witnesses.values()], 30000);
    row.flush = await Promise.all(logs.map(log => finishLog(log, 30000)));
    if (abortCleanup) row.abortCleanup = await abortCleanup;
    row.exit = exit?.code ?? null; row.signal = exit?.signal ?? null; row.endedUTC = new Date().toISOString();
    try { row.hashes = await Promise.all(Object.values(paths).map(fileHash)); } catch (error) { refusal ??= `raw log hash: ${error}`; }
    if (refusal || row.exit !== 0 || row.pipeTailCertified === false || row.cleanup.status !== 'complete' || row.flush.some(item => item.status !== 'complete')) {
      row.status = 'refused'; row.reason = refusal ?? 'native child/cleanup/log refused';
    } else row.status = 'complete';
    clearTimeout(pipeDeadline);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  return row;
}
