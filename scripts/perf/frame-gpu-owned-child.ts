/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

interface Identity { pid: number; session: number; startTicks: string; state: string }

function identity(pid: number): Identity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    if (!/^\d+$/.test(fields[3] ?? '') || !/^\d+$/.test(fields[19] ?? '')) throw new Error('invalid owned process identity');
    return { pid, state: fields[0], session: Number(fields[3]), startTicks: fields[19] };
  } catch (error) {
    const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
    if (code === 'ENOENT' || code === 'ESRCH') return null;
    throw error;
  }
}

const same = (a: Identity | null, b: Identity) => a?.startTicks === b.startTicks && a.session === b.session;

/** Discover descendants only while a previously proven member anchors the owned session. */
function discover(known: Map<number, Identity>, session: number): void {
  const anchored = [...known.values()].some((prior) => same(identity(prior.pid), prior));
  if (!anchored) return;
  for (const directory of readdirSync('/proc')) {
    if (!/^\d+$/.test(directory)) continue;
    const current = identity(Number(directory));
    if (current?.session === session) known.set(current.pid, current);
  }
}

function signalOwned(known: Map<number, Identity>, signal: NodeJS.Signals): void {
  for (const prior of known.values()) {
    const current = identity(prior.pid);
    if (!same(current, prior) || current?.state === 'Z') continue;
    try { process.kill(prior.pid, signal); }
    catch (error) {
      const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
      if (code !== 'ESRCH') throw error;
    }
  }
}

function liveOwned(known: Map<number, Identity>): Identity[] {
  return [...known.values()].filter((prior) => {
    const current = identity(prior.pid);
    return same(current, prior) && current?.state !== 'Z';
  });
}

export interface OwnedChildResult {
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  cleanupErrors: string[];
  observed: Identity[];
}

/**
 * The runner owns one newly created Linux session, never an arbitrary PID/group.
 * Signals target individual observed PID+start-time identities. Unknown orphan
 * sessions are reported, never killed by numeric group id after leader exit.
 * Windows children require the separately guarded profile recovery ledger.
 */
export async function runOwnedChild(options: {
  command: string; args: string[]; cwd: string; stdout: number; stderr: number;
  timeoutMs: number; graceMs?: number; signal?: AbortSignal;
}): Promise<OwnedChildResult> {
  if (process.platform !== 'linux') throw new Error('owned frame child requires Linux/WSL /proc identity');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('invalid owned child timeout');
  const grace = options.graceMs ?? 10_000;
  if (!Number.isInteger(grace) || grace <= 0) throw new Error('invalid owned child cleanup grace');
  const result: OwnedChildResult = { pid: null, exitCode: null, signal: null, timedOut: false, aborted: false, cleanupErrors: [], observed: [] };
  if (options.signal?.aborted) { result.aborted = true; return result; }
  const child = spawn(options.command, options.args, {
    cwd: options.cwd, detached: true, stdio: ['ignore', options.stdout, options.stderr],
  });
  result.pid = child.pid ?? null;
  let done = false;
  const terminal = new Promise<void>((resolve) => {
    child.once('error', (error) => { result.cleanupErrors.push(`child spawn: ${error.message}`); done = true; resolve(); });
    child.once('close', (code, signal) => { result.exitCode = code; result.signal = signal; done = true; resolve(); });
  });
  const known = new Map<number, Identity>();
  if (result.pid !== null) {
    try {
      const root = identity(result.pid);
      if (root && root.session !== root.pid) result.cleanupErrors.push('spawned child did not create its own session; identity cleanup refused');
      else if (root) known.set(root.pid, root);
    } catch (error) {
      // Preserve the bounded terminal wait and diagnostic even when /proc
      // observation fails; never kill an unverified numeric PID as a fallback.
      result.cleanupErrors.push(`owned root observation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let stop: (() => void) | undefined;
  const interrupted = new Promise<void>((resolve) => { stop = resolve; });
  const abort = () => { result.aborted = true; stop?.(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { result.timedOut = true; stop?.(); }, options.timeoutMs);
  try {
    await Promise.race([terminal, interrupted]);
    clearTimeout(timer);
    // Child handles can close while a pipe-free descendant still lives. Keep
    // all observed identities; do not use child.kill() on a reused numeric PID.
    if (result.pid !== null) discover(known, result.pid);
    if (!done || liveOwned(known).length > 0) {
      signalOwned(known, 'SIGTERM');
      const deadline = performance.now() + grace;
      while (liveOwned(known).length > 0 && performance.now() < deadline) {
        await sleep(50);
        if (result.pid !== null) discover(known, result.pid);
        signalOwned(known, 'SIGTERM');
      }
      signalOwned(known, 'SIGKILL');
      const killDeadline = performance.now() + grace;
      while ((!done || liveOwned(known).length > 0) && performance.now() < killDeadline) await sleep(50);
      if (!done) result.cleanupErrors.push('owned child did not report terminal close after cleanup');
      const remaining = liveOwned(known);
      if (remaining.length) result.cleanupErrors.push(`owned child processes remained: ${remaining.map((row) => row.pid).join(',')}`);
    }
    if (result.pid !== null) {
      for (const directory of readdirSync('/proc')) {
        if (!/^\d+$/.test(directory)) continue;
        const row = identity(Number(directory));
        if (row?.session === result.pid && row.state !== 'Z' && !known.has(row.pid)) {
          result.cleanupErrors.push(`unproven remaining process in former session: ${row.pid}`);
        }
      }
    }
    return { ...result, cleanupErrors: [...result.cleanupErrors], observed: [...known.values()] };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
