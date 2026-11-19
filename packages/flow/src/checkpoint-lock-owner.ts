/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';

export interface LockOwnerIdentity {
  pid: number;
  host: string;
  boot: string | null;
  start: string | null;
}
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const host = fingerprint(hostname());
async function optionalProcFile(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    // Missing/inaccessible procfs is an unsupported identity capability, not
    // evidence that a live PID belongs to another process. Fail closed below.
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
async function processStart(pid: number): Promise<string | null> {
  const text = await optionalProcFile(`/proc/${pid}/stat`);
  // comm can contain spaces and parentheses; field 22 follows the final ')'.
  const start = text?.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  return start && /^\d+$/.test(start) ? start : null;
}
export async function readLockIdentity(pid = process.pid): Promise<LockOwnerIdentity> {
  const boot = await optionalProcFile('/proc/sys/kernel/random/boot_id');
  return { pid, host, boot: boot ? fingerprint(boot.trim()) : null, start: await processStart(pid) };
}
export function lockOwnerName(identity: LockOwnerIdentity): string {
  return `${identity.pid}-v2-${identity.host}-${identity.boot ?? 'u'}-${identity.start ?? 'u'}-${randomUUID()}`;
}
export function parseLockOwner(name: string): LockOwnerIdentity | null {
  const match = /^([1-9]\d*)-v2-([a-f0-9]{16})-([a-f0-9]{16}|u)-(\d+|u)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.exec(name);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
  return { pid: Number(match[1]), host: match[2], boot: match[3] === 'u' ? null : match[3], start: match[4] === 'u' ? null : match[4] };
}
/** Only valid for a local filesystem shared within one host/PID namespace. */
export async function retiredLockOwner(owner: LockOwnerIdentity, lock: string): Promise<boolean> {
  const local = await readLockIdentity();
  if (owner.host !== local.host) throw new Error(`Checkpoint lock ${lock} is from another host; local PIDs cannot establish ownership. Verify the remote writer before removing it.`);
  if (owner.boot && local.boot && owner.boot !== local.boot) return true;
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    console.warn(`[FileCheckpointStore] Cannot establish liveness of old lock ${lock} PID ${owner.pid}; retaining lock`);
    return false;
  }
  const start = await processStart(owner.pid);
  if (owner.start && start && owner.start !== start) return true;
  console.warn(`[FileCheckpointStore] Old lock ${lock} has live PID ${owner.pid}; process identity matches or cannot be verified. Retaining lock; verify the writer before manual removal.`);
  return false;
}
