/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, realpathSync } from 'node:fs';

export interface NightWindow { night: string; startsAt: string; endsAt: string }
export interface NightAuthority extends NightWindow {
  sourceHead: string; profileSha256: string; checkout: string;
}

/** Refusals are retained attempts, never evidence of a supported native GPU. */
export class NightAdmissionRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'NightAdmissionRefusal'; }
}

export function requireNightWindow(window: NightWindow, now = new Date()): number {
  const start = Date.parse(window.startsAt), end = Date.parse(window.endsAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(window.night) || !Number.isFinite(start) || !Number.isFinite(end)
    || end <= start || end - start > 20 * 60_000
    || new Date(start).toISOString().slice(0, 10) !== window.night
    || new Date(end).toISOString().slice(0, 10) !== window.night) {
    throw new NightAdmissionRefusal('invalid explicit bounded UTC nightly window');
  }
  if (now.getTime() < start || now.getTime() >= end || now.toISOString().slice(0, 10) !== window.night) {
    throw new NightAdmissionRefusal('outside the scheduled nightly window; no late catch-up');
  }
  return end - now.getTime();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NightAdmissionRefusal('exclusive nightly lease unavailable');
  return value as Record<string, unknown>;
}

/** The coordinator preassigns this exact night; child release or an idle sample
 * cannot authorize taking somebody else's heavy lane. This reader never writes
 * or retires an owner record, including after an owner dies.
 */
export function requireNightLease(path: string, authority: NightAuthority): Record<string, unknown> {
  const owner = object(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  const grant = object(owner.nightExecutionGrant);
  if (owner.executionGrant !== true || typeof owner.activeAgent !== 'string' || !owner.activeAgent
    || grant.approved !== true || grant.issue !== 6975 || grant.activeAgent !== owner.activeAgent
    || typeof owner.worktree !== 'string' || realpathSync(owner.worktree) !== realpathSync(authority.checkout)
    || grant.sourceHead !== authority.sourceHead || grant.profileSha256 !== authority.profileSha256
    || grant.night !== authority.night || grant.startsAt !== authority.startsAt || grant.endsAt !== authority.endsAt
    || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new NightAdmissionRefusal('exact source/profile/window heavy execution grant missing');
  }
  try { process.kill(owner.pid, 0); }
  catch (error) { throw new NightAdmissionRefusal(`exclusive coordinator is not observable: ${String(error)}`); }
  return { pid: owner.pid, activeAgent: owner.activeAgent, worktree: owner.worktree,
    executionGrant: true, nightExecutionGrant: grant };
}

/** Sticky ownership observation: a later restored boundary cannot erase a
 * lease interruption. Abort only the child this invocation created.
 */
export function watchNightLease(path: string, authority: NightAuthority, cancel: AbortController): {
  stop(): { interruptions: number; firstError: string | null };
} {
  const expected = JSON.stringify(requireNightLease(path, authority));
  let interruptions = 0, firstError: string | null = null;
  const observe = () => {
    try {
      if (JSON.stringify(requireNightLease(path, authority)) !== expected) throw new NightAdmissionRefusal('nightly lease identity changed');
      requireNightWindow(authority);
    } catch (error) {
      interruptions++;
      firstError ??= String(error);
      if (!cancel.signal.aborted) cancel.abort(error);
    }
  };
  const timer = setInterval(observe, 250);
  return { stop() { clearInterval(timer); observe(); return { interruptions, firstError }; } };
}
