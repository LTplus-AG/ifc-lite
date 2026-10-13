/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import process from 'node:process';
import { readFile, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { hash, NATIVE_METADATA, record } from './bcf-publication-codec.js';
import type { NativeBcfOwnerStatus, StoredBcfAttempt } from './bcf-publication-types.js';

type Owner = StoredBcfAttempt['owner'];
const code = (error: unknown) => record(error) ? error.code : undefined;

async function linuxOwner(pid: number): Promise<Owner> {
  const [machine, boot, domain, stat] = await Promise.all([
    readFile('/etc/machine-id', 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    readlink('/proc/self/ns/pid'), readFile(`/proc/${pid}/stat`, 'utf8'),
  ]);
  // comm may contain spaces and parentheses; field22 follows the final ')'.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const start = fields[19];
  if (!machine.trim() || !boot.trim() || typeof start !== 'string' || !/^\d+$/.test(start)) throw new Error('Process identity unavailable');
  return { pid, host: hash(machine.trim()), boot: hash(boot.trim()), domain: hash(domain), instance: hash(start) };
}

/** Fixed native query, bounded output/time; no credential, shell interpolation or RPC. */
async function windowsOwner(pid: number): Promise<Owner> {
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if(!$p){exit 3}; `
    + '$m=Get-CimInstance Win32_ComputerSystemProduct; $o=Get-CimInstance Win32_OperatingSystem; '
    + '@{machine=$m.UUID;boot=$o.LastBootUpTime.ToUniversalTime().ToString("o");start=$p.CreationDate.ToUniversalTime().ToString("o")}|ConvertTo-Json -Compress';
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    let bytes = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Process identity query timed out')); }, 2_000);
    child.stdout.on('data', chunk => {
      bytes += String(chunk);
      if (bytes.length > 8_192) { child.kill(); reject(new Error('Process identity query exceeded bound')); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => {
      clearTimeout(timer);
      if (status === 0) resolve(bytes);
      else reject(Object.assign(new Error('Process identity query unavailable'), { code: status === 3 ? 'ESRCH' : 'EIO' }));
    });
  });
  const value: unknown = JSON.parse(output);
  if (!record(value) || !['machine', 'boot', 'start'].every(k => typeof value[k] === 'string' && value[k])) {
    throw new Error('Invalid process identity response');
  }
  return { pid, host: hash(String(value.machine)), boot: hash(String(value.boot)), domain: hash('windows'), instance: hash(String(value.start)) };
}

async function observedOwner(pid: number): Promise<Owner> {
  if (process.platform === 'linux') return linuxOwner(pid);
  if (process.platform === 'win32') return windowsOwner(pid);
  throw new Error('Process identity unsupported on this host');
}

export async function currentOwner(): Promise<Owner> {
  try { return await observedOwner(process.pid); }
  catch { return { pid: process.pid, host: hash(hostname()) }; } // Explicit unknown identity; never proof of death.
}

/** PID existence alone cannot identify a process instance. Foreign/legacy owners stay unknown. */
export async function ownerStatus(attempt: StoredBcfAttempt): Promise<NativeBcfOwnerStatus> {
  const owner = attempt.owner;
  if (!owner.instance || !owner.boot || !owner.domain) return NATIVE_METADATA.owner.unknown;
  let local: Owner;
  try { local = await observedOwner(process.pid); } catch { return NATIVE_METADATA.owner.unknown; }
  if (local.host !== owner.host || !local.boot || !local.domain) return NATIVE_METADATA.owner.unknown;
  if (local.boot !== owner.boot) return NATIVE_METADATA.owner.dead;
  if (local.domain !== owner.domain) return NATIVE_METADATA.owner.unknown;
  try {
    const observed = await observedOwner(owner.pid);
    return observed.instance === owner.instance ? NATIVE_METADATA.owner.alive : NATIVE_METADATA.owner.dead;
  } catch (error) { return ['ENOENT', 'ESRCH'].includes(String(code(error))) ? NATIVE_METADATA.owner.dead : NATIVE_METADATA.owner.unknown; }
}
