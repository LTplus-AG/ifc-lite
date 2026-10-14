/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOwnedChild, type OwnedChildResult } from './frame-gpu-owned-child.js';

type Identity = OwnedChildResult['observed'][number];
export interface NightProcessResult {
  argv: readonly string[]; pid: number | null; pgid: number | null;
  exit: number | null; signal: NodeJS.Signals | null; timedOut: boolean;
  cancellation: string | null; observed: Identity[]; liveOwned: Identity[];
  cleanupError: string | null; stdout: string; stderr: string;
}

function remains(prior: Identity): boolean {
  try {
    const stat = readFileSync(`/proc/${prior.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return fields[19] === prior.startTicks && Number(fields[3]) === prior.session && fields[0] !== 'Z';
  } catch (error) {
    const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
    if (code === 'ENOENT' || code === 'ESRCH') return false;
    throw error;
  }
}

/** Reuse canonical held-identity Linux session custody. Windows Chrome remains
 * the native Job controller's responsibility; no timeout invents retirement.
 */
export async function runNightProcess(options: {
  argv: readonly string[]; cwd: string; directory: string; budgetMs: number;
  signal?: AbortSignal; cleanupMs?: number;
}): Promise<NightProcessResult> {
  if (process.platform !== 'linux' || !options.argv.length || !Number.isSafeInteger(options.budgetMs)
    || options.budgetMs <= 0 || options.budgetMs > 20 * 60_000) throw new Error('bounded WSL invocation required');
  const cleanupMs = options.cleanupMs ?? 45_000;
  if (!Number.isSafeInteger(cleanupMs) || cleanupMs <= 0 || cleanupMs > 60_000) throw new Error('bounded owned cleanup required');
  const stdout = join(options.directory, 'rig.stdout'), stderr = join(options.directory, 'rig.stderr');
  const out = openSync(stdout, 'wx', 0o600);
  let err: number | undefined;
  try {
    err = openSync(stderr, 'wx', 0o600);
    const child = await runOwnedChild({ command: options.argv[0], args: [...options.argv.slice(1)], cwd: options.cwd,
      stdout: out, stderr: err, timeoutMs: options.budgetMs, graceMs: cleanupMs, signal: options.signal });
    const result: NightProcessResult = { argv: options.argv, pid: child.pid, pgid: child.pid,
      exit: child.exitCode, signal: child.signal, timedOut: child.timedOut,
      cancellation: child.aborted ? String(options.signal?.reason ?? 'owned invocation aborted') : null,
      observed: child.observed, liveOwned: child.observed.filter(remains),
      cleanupError: child.cleanupErrors.length ? child.cleanupErrors.join('; ') : null, stdout, stderr };
    writeFileSync(join(options.directory, 'rig-process.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    return result;
  } finally {
    closeSync(out); if (err !== undefined) closeSync(err);
  }
}
