/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { RAW_LIMITS, backendErrors, canSignalOwnedGroup } from './gpu-control.mjs';
import { processIdentity, finishLog, stopWitnessedProcesses } from './interleaved-cleanup.mjs';

function descendants(rootPid) {
  const pids = readdirSync('/proc').filter(value => /^\d+$/.test(value));
  if (pids.length > 4096) throw new Error('Process census bound exceeded');
  const processes = pids.map(processIdentity).filter(Boolean);
  const ids = new Set([rootPid]);
  for (let depth = 0; depth < 32; depth++) {
    const prior = ids.size;
    for (const item of processes) if (ids.has(item.ppid)) ids.add(item.pid);
    if (ids.size === prior) return processes.filter(item => ids.has(item.pid));
  }
  throw new Error('Owned process tree depth exceeded');
}
export async function runGpuChild({ root, output, name, args, eventFile, wallMs = 75000, onAbort = () => {} }) {
  const owned = new Map(), paths = ['stdout', 'stderr'].map(stream => join(output, `${name}.${stream}.log`));
  const logs = paths.map(path => createWriteStream(path, { flags: 'wx' }));
  const child = spawn(process.execPath, args,
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
  onAbort(abort);
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
  const monitor = setInterval(remember, 100), timer = setTimeout(() => abort('One-control wall deadline'), wallMs);
  const exit = await new Promise(resolveExit => {
    settle = resolveExit;
    child.once('error', error => { abort(`Spawn failed: ${error}`); resolveExit({ code: null, spawnError: String(error) }); });
    child.once('close', (code, signal) => { closed = true; resolveExit({ code, signal }); });
  });
  clearInterval(monitor); clearTimeout(timer); clearTimeout(exitTimer); onAbort(undefined);
  const deadline = Date.now() + 30000;
  const [cleanup, ...flushes] = await Promise.all([
    stopWitnessedProcesses([...owned.values()], 30000).catch(error => ({ status: 'refused', reason: String(error) })),
    ...logs.map(log => finishLog(log, Math.max(1, deadline - Date.now()))),
  ]);
  let row;
  try { row = JSON.parse(readFileSync(join(output, `${name}.json`), 'utf8')); }
  catch (error) { row = { profile: name, status: 'refused', events: [], reason: `No readable result: ${error}` }; }
  let backend = [];
  try { backend = backendErrors(paths.map(path => readFileSync(path, 'utf8')).join('\n')); }
  catch (error) { refusal ??= `Raw log unreadable: ${error}`; }
  if (eventFile) {
    try { row.events = readFileSync(join(output, eventFile), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { refusal ??= `Raw event record unreadable: ${error}`; }
  }
  if (row.ownedCleanup) row.childOwnedCleanup = row.ownedCleanup;
  Object.assign(row, { backendErrors: backend, exit, rootIdentity, ownedCleanup: cleanup, logFlushes: flushes, logBytes });
  return { row, backend, exit, cleanup, flushes, refusal, paths };
}
