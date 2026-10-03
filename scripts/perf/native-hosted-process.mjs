/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { fileHash } from './interleaved-assets.mjs';
import { processIdentity, finishLog, stopWitnessedProcesses } from './interleaved-cleanup.mjs';
import { available, ownedSnapshot } from './sdk-resources.mjs';
import { classifyBuildTestProcess } from './sdk-process-classification.mjs';
import { freshnessException, limits } from './native-hosted-plan.mjs';
function graphScan(witnesses, expected) {
  const exceptions = [];
  for (const name of readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    try {
      const argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const executable = readlinkSync(`/proc/${name}/exe`), classification = classifyBuildTestProcess(argv, executable);
      if (!classification) continue;
      const identity = processIdentity(name);
      if (!identity) continue;
      const record = { ...identity, argv, executable, cwd: readlinkSync(`/proc/${name}/cwd`) };
      if (!freshnessException(record, witnesses.get(record.pid), expected)) throw new Error(`non-exempt compiler/test graph: ${JSON.stringify({ pid: record.pid, classification })}`);
      exceptions.push({ ...identity, classification, executable, cwd: record.cwd });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return exceptions;
}
export async function execute(command, directory, prefix, { sample = false, tools, wallMs = 180000 } = {}) {
  const executable = tools && ['bash', 'cargo'].includes(command[0]) ? tools[command[0]] : command[0];
  const paths = { stdout: `${prefix}.stdout`, stderr: `${prefix}.stderr` };
  const logs = Object.values(paths).map(path => createWriteStream(path, { flags: 'wx' }));
  const row = { status: 'pending', command, executable, directory, paths, startedUTC: new Date().toISOString(), samples: [], cargoExceptions: [] };
  const witnesses = new Map(); let child, refusal, monitor, deadline, pipeDeadline, settle, exit, abortCleanup;
  const abort = reason => {
    refusal ??= String(reason);
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
      env: { ...process.env, OBS: '0', CARGO_BUILD_JOBS: '1', CARGO_TERM_COLOR: 'never' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
        if (sample) for (const item of graphScan(witnesses, { ...tools, directory, group: child.pid })) {
          if (!row.cargoExceptions.some(prior => prior.pid === item.pid && prior.startTime === item.startTime)) row.cargoExceptions.push(item);
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
