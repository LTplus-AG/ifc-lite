/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, createWriteStream, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PROFILES, RAW_LIMITS, backendErrors, verdict, interpretation, canSignalOwnedGroup, requireCompletion } from './gpu-control.mjs';
import { processIdentity, finishLog, stopWitnessedProcesses } from './interleaved-cleanup.mjs';
import { fileHash } from './interleaved-assets.mjs';

const root = resolve(import.meta.dirname, '../..'), output = join(root, 'gpu-results');
mkdirSync(output, { recursive: true });
const report = { status: 'started', profiles: [], plannedControls: 2, retries: 0, startedUTC: new Date().toISOString() };
let activeAbort, interrupted;
const handlers = ['SIGTERM', 'SIGINT'].map(signal => [signal, () => { interrupted = signal; activeAbort?.(`Interrupted by ${signal}`); }]);
for (const [signal, handler] of handlers) process.on(signal, handler);
function descendants(rootPid) {
  const processes = readdirSync('/proc').filter(value => /^\d+$/.test(value)).map(processIdentity).filter(Boolean);
  const ids = new Set([rootPid]);
  for (let depth = 0; depth < 32; depth++) {
    const prior = ids.size;
    for (const item of processes) if (ids.has(item.ppid)) ids.add(item.pid);
    if (ids.size === prior) return processes.filter(item => ids.has(item.pid));
  }
  throw new Error('Owned process tree depth exceeded');
}
async function control(profile) {
  const owned = new Map(), paths = ['stdout', 'stderr'].map(stream => join(output, `${profile.name}.${stream}.log`));
  const logs = paths.map(path => createWriteStream(path, { flags: 'wx' }));
  const child = spawn(process.execPath, ['scripts/perf/gpu-sample.mjs', profile.name, output],
    { cwd: root, env: { ...process.env, DEBUG: 'pw:browser', DEBUG_COLORS: '0' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const rootIdentity = child.pid ? processIdentity(child.pid) : null;
  if (rootIdentity) owned.set(rootIdentity.pid, rootIdentity);
  let refusal, settle, closed = false, exitTimer;
  const abort = reason => {
    refusal ??= reason;
    if (!closed && child.pid) {
      try { if (canSignalOwnedGroup(rootIdentity, processIdentity(child.pid))) process.kill(-rootIdentity.pgrp, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') refusal += `; ${error}`; }
    }
    if (!closed) exitTimer ??= setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); settle?.({ code: null, signal: 'close-deadline' }); }, 30000);
  };
  activeAbort = abort;
  const logBytes = [0, 0];
  for (const [index, stream] of [child.stdout, child.stderr].entries()) stream.on('data', bytes => {
    const prefix = bytes.subarray(0, Math.max(0, RAW_LIMITS.logBytes - logBytes[index]));
    logBytes[index] += prefix.length;
    if (prefix.length && !logs[index].write(prefix)) { stream.pause(); logs[index].once('drain', () => stream.resume()); }
    if (prefix.length < bytes.length) abort('Raw log limit reached; retained prefix only, tail uncertified');
  });
  for (const log of logs) log.on('error', error => abort(`Log error: ${error}`));
  const remember = () => {
    try {
      if (!canSignalOwnedGroup(rootIdentity, processIdentity(child.pid))) return;
      const members = descendants(child.pid);
      if (canSignalOwnedGroup(rootIdentity, processIdentity(child.pid))) for (const item of members) owned.set(item.pid, item);
    }
    catch (error) { abort(`Process witness failed: ${error}`); }
  };
  if (child.pid) remember();
  const monitor = setInterval(remember, 100), timer = setTimeout(() => abort('One-control wall deadline'), 75000);
  const exit = await new Promise(resolveExit => {
    settle = resolveExit;
    child.once('error', error => { abort(`Spawn failed: ${error}`); resolveExit({ code: null, spawnError: String(error) }); });
    child.once('close', (code, signal) => { closed = true; resolveExit({ code, signal }); });
  });
  clearInterval(monitor); clearTimeout(timer); clearTimeout(exitTimer); activeAbort = undefined;
  const deadline = Date.now() + 30000;
  const [cleanup, ...flushes] = await Promise.all([
    stopWitnessedProcesses([...owned.values()], 30000).catch(error => ({ status: 'refused', reason: String(error) })),
    ...logs.map(log => finishLog(log, Math.max(1, deadline - Date.now()))),
  ]);
  let row;
  try { row = JSON.parse(readFileSync(join(output, `${profile.name}.json`), 'utf8')); }
  catch (error) { row = { profile: profile.name, status: 'refused', events: [], reason: `No readable result: ${error}` }; }
  let backend = [];
  try { backend = backendErrors(paths.map(path => readFileSync(path, 'utf8')).join('\n')); }
  catch (error) { refusal ??= `Raw log unreadable: ${error}`; }
  try { row.events = readFileSync(join(output, `${profile.name}.events.jsonl`), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { refusal ??= `Raw event record unreadable: ${error}`; }
  Object.assign(row, { backendErrors: backend, exit, rootIdentity, ownedCleanup: cleanup, logFlushes: flushes, logBytes });
  const childStatus = row.status; row.status = verdict(row, backend);
  row.childStatus = childStatus;
  if (row.status === 'refused') row.reason ??= 'Pixel/frame witness or observed GPU/backend error refused';
  if (refusal || exit.code !== 0 || cleanup.status !== 'complete' || flushes.some(value => value.status !== 'complete') || row.teardown !== 'complete') {
    row.status = 'refused'; row.reason ??= refusal ?? 'Child/cleanup/log/teardown refused';
  }
  writeFileSync(join(output, `${profile.name}.json`), JSON.stringify(row, null, 2));
  return row;
}
try {
  if (process.platform !== 'linux' || process.env.CI !== 'true') throw new Error('Hosted Linux control only');
  report.harness = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim(),
    scope: 'Listed harness inputs only; not a whole-machine or dependency closure', sources: {},
    node: { version: process.version, executable: realpathSync(process.execPath), sha256: await fileHash(process.execPath) } };
  for (const path of ['.github/workflows/benchmark.yml', '.github/workflows/perf-gpu-check.yml', 'package.json', 'pnpm-lock.yaml',
    ...['gpu-control.mjs', 'gpu-page.mjs', 'gpu-run.mjs', 'gpu-sample.mjs', 'interleaved-assets.mjs', 'interleaved-cleanup.mjs'].map(name => `scripts/perf/${name}`)])
    report.harness.sources[path] = await fileHash(join(root, path));
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  for (const profile of PROFILES) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}; remaining control not run`);
    report.profiles.push(await control(profile));
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  report.interpretation = interpretation(report.profiles);
  report.status = requireCompletion(report.profiles, interrupted);
} catch (error) { report.status = 'refused'; report.reason = String(error); process.exitCode = 1; }
finally {
  if (interrupted) { report.status = 'refused'; report.reason = `Interrupted by ${interrupted}; completion refused`; process.exitCode = 1; }
  report.endedUTC = new Date().toISOString();
  try { writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); }
  finally { for (const [signal, handler] of handlers) process.removeListener(signal, handler); }
}
