/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchOwnedJob, type JobPrepared, type OwnedJobController } from './frame-gpu-job-controller.js';

export interface ChromeOwner {
  version: 1; token: string; profileWsl: string; profileWin: string; ledger?: string;
}
export interface PreparedChromeOwner {
  version: 1; owner: ChromeOwner; job: JobPrepared; backendSHA256: Record<string, string>;
}
export interface ProfileJobLimits { requestMs: number; cleanupMs: number; lifetimeSeconds: number; signal?: AbortSignal }
export interface OwnedProfileJob {
  owner: ChromeOwner; prepared: PreparedChromeOwner; controller: OwnedJobController;
  dispose(): Promise<string | null>;
}
const MARKER = '.ifclite-frame-owner.json';
const PREPARED = '.ifclite-frame-job.json';
const BACKENDS = ['frame-gpu-job-controller.ts', 'frame-gpu-job-supervisor.ps1', 'frame-gpu-job-input.cs', 'frame-gpu-job.cs', 'frame-gpu-process-identity.cs'];
const run = (command: string, args: string[], timeout = 5_000): string => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.replace(/\r/g, '').trim();
};
function durableExclusive(path: string, value: unknown): void {
  const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx');
  try {
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    // Atomic publication without replacing an existing owner/ledger record.
    // Unsupported filesystem durability refuses persistence before root resume.
    linkSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { unlinkSync(temporary); }
}
/** One immutable marker policy, also used by CPU fixtures of the Job binding. */
export function createChromeOwner(ledger?: string): ChromeOwner {
  const token = randomBytes(16).toString('hex');
  const tempWin = `${run('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'])}\\Temp`;
  const profileWsl = join(run('wslpath', ['-u', tempWin]), `ifclite-frame-rig-${token}`);
  mkdirSync(profileWsl);
  try {
    const owner: ChromeOwner = { version: 1, token, profileWsl, profileWin: run('wslpath', ['-w', profileWsl]),
      ...(ledger ? { ledger: resolve(ledger) } : {}) };
    durableExclusive(join(profileWsl, MARKER), owner);
    if (owner.ledger) {
      mkdirSync(owner.ledger, { recursive: true });
      durableExclusive(join(owner.ledger, `${token}.owner.json`), owner);
    }
    return owner;
  } catch (error) {
    rmSync(profileWsl, { recursive: true, force: true }); // No Windows root has been created.
    throw error;
  }
}
/** Foreign, altered or unmapped profiles are never adopted for cleanup. */
export function decodeChromeOwner(value: unknown): ChromeOwner {
  if (!value || typeof value !== 'object' || Reflect.get(value, 'version') !== 1) throw new Error('invalid Chrome owner');
  const token: unknown = Reflect.get(value, 'token'), profileWsl: unknown = Reflect.get(value, 'profileWsl');
  const profileWin: unknown = Reflect.get(value, 'profileWin'), ledger: unknown = Reflect.get(value, 'ledger');
  if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)
    || typeof profileWsl !== 'string' || basename(profileWsl) !== `ifclite-frame-rig-${token}`
    || typeof profileWin !== 'string' || !profileWin.endsWith(`\\ifclite-frame-rig-${token}`)
    || (ledger !== undefined && (typeof ledger !== 'string' || resolve(ledger) !== ledger))) throw new Error('invalid Chrome ownership identity');
  const marker: unknown = JSON.parse(readFileSync(join(profileWsl, MARKER), 'utf8'));
  if (!marker || typeof marker !== 'object'
    || ['version', 'token', 'profileWsl', 'profileWin', 'ledger'].some(field => Reflect.get(marker, field) !== Reflect.get(value, field))) throw new Error('Chrome profile ownership marker changed');
  if (run('wslpath', ['-w', profileWsl]) !== profileWin) throw new Error('Chrome profile path mapping changed');
  const tempWin = `${run('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'])}\\Temp`;
  if (resolve(dirname(profileWsl)) !== resolve(run('wslpath', ['-u', tempWin]))) throw new Error('Chrome profile is outside the current Windows user temporary directory');
  if (typeof ledger === 'string' && readFileSync(join(ledger, `${token}.owner.json`), 'utf8') !== JSON.stringify(marker)) throw new Error('Chrome owner ledger changed');
  return value as ChromeOwner;
}
/** Windows argv quoting; the canonical native parser supplies the round-trip oracle. */
export function windowsCommandLine(executable: string, args: readonly string[]): string {
  const quote = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
  return [executable, ...args].map(quote).join(' ');
}
function backendPins(): Record<string, string> {
  return Object.fromEntries(BACKENDS.map(file => [file, createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex')]));
}
function readPrepared(owner: ChromeOwner): PreparedChromeOwner {
  decodeChromeOwner(owner);
  const bytes = readFileSync(join(owner.profileWsl, PREPARED), 'utf8');
  const value: unknown = JSON.parse(bytes);
  if (!value || typeof value !== 'object') throw Error('Missing durable Job owner');
  const prepared = value as PreparedChromeOwner;
  if (prepared.version !== 1 || JSON.stringify(prepared.owner) !== JSON.stringify(owner)
    || prepared.job?.jobName !== `Local\\ifclite-owned-${owner.token}`
    || JSON.stringify(prepared.backendSHA256) !== JSON.stringify(backendPins())) throw Error('Durable Job binding changed');
  for (const pid of [prepared.job.rootPid, prepared.job.supervisorPid]) if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid durable Windows PID');
  for (const stamp of [prepared.job.rootCreated, prepared.job.supervisorCreated]) if (typeof stamp !== 'string' || !/^[1-9][0-9]*$/.test(stamp)) throw Error('Invalid durable Windows creation stamp');
  if (owner.ledger && readFileSync(join(owner.ledger, `${owner.token}.job.json`), 'utf8') !== bytes) throw Error('Durable Job ledger changed');
  return prepared;
}
/** No recovery by name/profile absence. Only this live controller owns retirement. */
export async function launchOwnedProfileJob(ownerValue: ChromeOwner, executable: string, args: readonly string[], limits: ProfileJobLimits): Promise<OwnedProfileJob> {
  limits.signal?.throwIfAborted();
  const owner = decodeChromeOwner(ownerValue);
  for (const value of [limits.requestMs, limits.cleanupMs, limits.lifetimeSeconds]) if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid owned profile Job deadline');
  if (limits.requestMs > 60000 || limits.cleanupMs > 60000 || limits.lifetimeSeconds > 1800) throw Error('Owned profile Job deadline exceeds bound');
  const pins = backendPins();
  const win = (file: string) => run('wslpath', ['-w', fileURLToPath(new URL(file, import.meta.url))]);
  const controller = await launchOwnedJob({ token: owner.token, executable, commandLine: windowsCommandLine(executable, args),
    supervisorWin: win('frame-gpu-job-supervisor.ps1'), jobModuleWin: win('frame-gpu-job.cs'), inputModuleWin: win('frame-gpu-job-input.cs'), ...limits,
    async persistPrepared(job) {
      limits.signal?.throwIfAborted();
      decodeChromeOwner(owner);
      if (JSON.stringify(backendPins()) !== JSON.stringify(pins)) throw Error('Job backend source changed before persistence');
      const prepared: PreparedChromeOwner = { version: 1, owner, job, backendSHA256: pins };
      durableExclusive(join(owner.profileWsl, PREPARED), prepared);
      if (owner.ledger) durableExclusive(join(owner.ledger, `${owner.token}.job.json`), prepared);
      readPrepared(owner);
      limits.signal?.throwIfAborted();
    },
  });
  let prepared: PreparedChromeOwner;
  try { prepared = readPrepared(owner); }
  catch (error) {
    try { await controller.dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Prepared owner verification and Job retirement failed; retain profile'); }
    throw error;
  }
  let disposal: Promise<string | null> | undefined;
  const abort = () => { void session.dispose().then(error => { if (error) console.error(error); }); };
  const session: OwnedProfileJob = { owner, prepared, controller, dispose() {
    limits.signal?.removeEventListener('abort', abort);
    return disposal ??= (async () => {
      try {
        // The live controller still owns its original Job if a disk marker is
        // altered. Retire that known Job, but never delete an unverified profile.
        let markerFailure: unknown;
        try { if (JSON.stringify(readPrepared(owner)) !== JSON.stringify(prepared)) throw Error('Prepared Job identity changed before retirement'); }
        catch (error) { markerFailure = error; }
        await controller.dispose(); // active-zero + terminal + exit0/null signal.
        if (markerFailure) throw markerFailure;
        if (JSON.stringify(readPrepared(owner)) !== JSON.stringify(prepared)) throw Error('Prepared owner changed during Job retirement');
        const receipt = { prepared, retiredAt: new Date().toISOString(), packets: controller.receipts };
        if (owner.ledger) durableExclusive(join(owner.ledger, `${owner.token}.retired.json`), receipt);
        run(process.execPath, ['-e', 'const fs=require("node:fs");fs.rmSync(process.argv[1],{recursive:true,force:true});if(fs.existsSync(process.argv[1]))process.exit(2)', owner.profileWsl], limits.cleanupMs);
        if (existsSync(owner.profileWsl)) throw Error('Owned profile deletion unproved');
        if (owner.ledger) durableExclusive(join(owner.ledger, `${owner.token}.disposed.json`), receipt);
        return null;
      } catch (error) { return `Owned profile retirement refused; retain ledger: ${String(error)}`; }
    })();
  } };
  limits.signal?.addEventListener('abort', abort, { once: true });
  if (limits.signal?.aborted) {
    const cleanup = await session.dispose();
    throw new Error(`Owned profile Job aborted after preparation${cleanup ? `; ${cleanup}` : ''}`);
  }
  return session;
}
