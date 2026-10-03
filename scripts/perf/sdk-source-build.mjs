/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileHash } from './interleaved-assets.mjs';
import { finishLog, processIdentity, stopWitnessedProcesses } from './interleaved-cleanup.mjs';
import { output, verifySource } from './sdk-prepare.mjs';
import { ownedSnapshot } from './sdk-resources.mjs';
import { buildOutcomes } from './sdk-build-contract.mjs';
import { requireBindgen } from './sdk-bindgen.mjs';
import { requireBuildCompletion } from './sdk-completion.mjs';
const arm = process.argv[2], start = JSON.parse(readFileSync(join(output, 'build-start.json'), 'utf8'));
if (!['base', 'candidate'].includes(arm)) throw new Error('explicit arm required');
const directory = start.directories[arm], revision = start.revisions[arm];
const command = ['pnpm', 'turbo', 'build', '--force', '--filter=@ifc-lite/geometry', '--concurrency=1', '--env-mode=loose'];
const logPath = join(output, `${arm}-source-build.log`), log = createWriteStream(logPath, { flags: 'wx' });
const receipt = { status: 'pending', arm, directory, revision, command, cargoTargetDir: process.env.CARGO_TARGET_DIR, startedUTC: new Date().toISOString(), logPath };
const witnesses = new Map(); let child, timer, deadline, refusal, exit, settle, closeTimer, abortCleanup;
function abort(reason) {
  refusal ??= String(reason);
  const witness = witnesses.get(child?.pid), current = child?.pid ? processIdentity(child.pid) : null;
  if (witness && current?.startTime === witness.startTime && current.pgrp === child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') refusal += `; ${error}`; }
  }
  abortCleanup ??= stopWitnessedProcesses([...witnesses.values()], 30000);
  closeTimer ??= setTimeout(() => { receipt.pipeTailCertified = false; child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); settle?.({ code: null, signal: 'owned-close-deadline' }); }, 30000);
}
const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => abort(`received ${signal}`)]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
log.on('error', error => abort(`build log write: ${error}`));
try {
  if (!process.env.RUNNER_TEMP || receipt.cargoTargetDir !== join(process.env.RUNNER_TEMP, `sdk-${arm}-cargo`)
    || existsSync(receipt.cargoTargetDir)) throw new Error('new isolated arm Cargo target required');
  if (process.env.CI !== 'true' || process.env.DEBUG_GEOMETRY === '1' || process.env.BUILD_WIDE === '1') throw new Error('default CI WASM build required');
  receipt.transformBefore = await requireBindgen(start.bindgen, start.directories);
  await verifySource(start.sources.find(source => source.directory === directory));
  if (refusal) throw new Error(refusal);
  child = spawn(command[0], command.slice(1), { cwd: directory, env: { ...process.env, FORCE_COLOR: '0' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const identity = processIdentity(child.pid); if (!identity) throw new Error('build PID witness absent'); witnesses.set(identity.pid, identity);
  timer = setInterval(() => { try { for (const item of ownedSnapshot(process.pid).members) witnesses.set(item.pid, item); } catch (error) { abort(error); } }, 250);
  deadline = setTimeout(() => { abort('source build 60-minute wall limit'); }, 60 * 60000);
  exit = await new Promise((accept, reject) => { settle = accept; child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })); });
} catch (error) { abort(error); }
finally {
  clearInterval(timer); clearTimeout(deadline); clearTimeout(closeTimer);
  if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  [receipt.cleanup, receipt.logFlush] = await Promise.all([stopWitnessedProcesses([...witnesses.values()], 30000), finishLog(log, 30000)]);
  if (abortCleanup) receipt.abortCleanup = await abortCleanup;
}
try {
  receipt.exit = exit?.code ?? null; receipt.signal = exit?.signal ?? null; receipt.endedUTC = new Date().toISOString();
  receipt.logSha256 = await fileHash(logPath);
  requireBuildCompletion(receipt, refusal);
  receipt.taskOutcomes = buildOutcomes(readFileSync(logPath, 'utf8'));
  const wasm = join(directory, 'packages/wasm/pkg/ifc-lite_bg.wasm');
  if (statSync(wasm).mtimeMs < start.timestampMs) throw new Error('WASM freshness refused');
  receipt.wasmSha256 = await fileHash(wasm); receipt.wasmBytes = statSync(wasm).size;
  await verifySource(start.sources.find(source => source.directory === directory));
  receipt.transformAfter = await requireBindgen(start.bindgen, start.directories);
  requireBuildCompletion(receipt, refusal);
  receipt.status = 'complete-source-build';
} catch (error) { receipt.status = 'refused'; receipt.reason = String(error); process.exitCode = 1; }
writeFileSync(join(output, `${arm}-source-build.json`), JSON.stringify(receipt, null, 2));

for (const [signal, handler] of signalHandlers) process.off(signal, handler);
