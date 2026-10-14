/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { sha256 } from './frame-gpu-night-profile.js';
import { NightAdmissionRefusal, requireNightWindow, type NightAuthority, type NightWindow } from './frame-gpu-night-lease.js';

interface NightAuthorization {
  version: 1; approved: true; issue: 6975; approvedAt: string;
  checkout: string; leaseFile: string; sourceHead: string; profileSha256: string;
  reservation: { startsAt: string; endsAt: string }; windows: NightWindow[];
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NightAdmissionRefusal('standing nightly authorization unavailable');
  return value as Record<string, unknown>;
};

/** The reviewed task action pins these exact bytes. Approval is standing for
 * seven future windows, not dependent on a T3 coordinator remaining alive.
 */
export function requireNightAuthorization(path: string, expectedSha256: string, leaseFile: string, authority: NightAuthority): NightAuthorization {
  const bytes = readFileSync(path);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256(bytes) !== expectedSha256) throw new NightAdmissionRefusal('standing authorization bytes changed');
  const row = object(JSON.parse(bytes.toString('utf8')) as unknown), reservation = object(row.reservation);
  const approvedAt = typeof row.approvedAt === 'string' ? Date.parse(row.approvedAt) : NaN;
  const reservedStart = typeof reservation.startsAt === 'string' ? Date.parse(reservation.startsAt) : NaN;
  const reservedEnd = typeof reservation.endsAt === 'string' ? Date.parse(reservation.endsAt) : NaN;
  if (row.version !== 1 || row.approved !== true || row.issue !== 6975 || !Number.isFinite(approvedAt)
    || approvedAt > Date.now() || !Number.isFinite(reservedStart) || !Number.isFinite(reservedEnd) || reservedEnd <= reservedStart
    || row.checkout !== authority.checkout || row.leaseFile !== leaseFile
    || row.sourceHead !== authority.sourceHead || row.profileSha256 !== authority.profileSha256
    || !Array.isArray(row.windows) || row.windows.length !== 7) throw new NightAdmissionRefusal('standing source/reservation authority mismatch');
  let previous: number | undefined, chosen = false;
  for (const value of row.windows as unknown[]) {
    const window = object(value);
    if (typeof window.night !== 'string' || typeof window.startsAt !== 'string' || typeof window.endsAt !== 'string') {
      throw new NightAdmissionRefusal('standing nightly window invalid');
    }
    const start = Date.parse(window.startsAt), end = Date.parse(window.endsAt);
    const actual: NightWindow = { night: window.night, startsAt: window.startsAt, endsAt: window.endsAt };
    requireNightWindow(actual, new Date(start));
    const day = Date.parse(`${window.night}T00:00:00Z`);
    if (start <= approvedAt || start < reservedStart || end > reservedEnd || (previous !== undefined && day - previous !== 86_400_000)) {
      throw new NightAdmissionRefusal('seven future consecutive nights must fit the approved reservation');
    }
    // Preserve the already allocated #6709 hardware window, even if an
    // incorrectly prepared reservation otherwise includes it.
    if (start < Date.parse('2026-10-13T23:45:00Z') && end > Date.parse('2026-10-13T23:00:00Z')) {
      throw new NightAdmissionRefusal('standing night overlaps reserved b95 hardware window');
    }
    previous = day;
    chosen ||= window.night === authority.night && window.startsAt === authority.startsAt && window.endsAt === authority.endsAt;
  }
  if (!chosen) throw new NightAdmissionRefusal('this exact night was not preapproved');
  requireNightWindow(authority);
  return row as unknown as NightAuthorization;
}

function creation(): string {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const ticks = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
  if (!/^\d+$/.test(ticks ?? '')) throw new Error('actual nightly coordinator identity unavailable');
  return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${ticks}`;
}

export interface AcquiredNightLease {
  token: string; ownerSHA256: string;
  /** Call only after actual child and native Job retirement is proved. */
  release(): void;
}

/** Reuse the campaign's atomic lock-directory convention. An existing path is
 * contention even when its JSON says released or its PID appears dead. Never
 * adopt, overwrite or kill another owner. All development writers must honor
 * this same shared directory before unattended scheduling is enabled.
 */
export function acquireNightLease(options: {
  authorization: { path: string; sha256: string }; leaseFile: string; authority: NightAuthority;
}): AcquiredNightLease {
  requireNightAuthorization(options.authorization.path, options.authorization.sha256, options.leaseFile, options.authority);
  const directory = dirname(options.leaseFile);
  if (basename(options.leaseFile) !== 'owner.json' || resolve(directory) !== directory
    || join(realpathSync(dirname(directory)), basename(directory)) !== directory) throw new NightAdmissionRefusal('canonical shared lock path required');
  const token = randomBytes(16).toString('hex'), started = creation();
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'EEXIST') throw new NightAdmissionRefusal('coordinated heavy lane already reserved; no stale takeover');
    throw error;
  }
  const authority = options.authority, agent = `6975-native-night/${token}`;
  const owner = { owner: '6975-preapproved-night', pid: process.pid, activeAgent: agent, worktree: authority.checkout,
    executionGrant: true, createdAt: new Date().toISOString(), maxSeconds: 1200,
    nightOwnerToken: token, nightOwnerCreation: started, authorizationSHA256: options.authorization.sha256,
    nightExecutionGrant: { approved: true, issue: 6975, activeAgent: agent, sourceHead: authority.sourceHead,
      profileSha256: authority.profileSha256, night: authority.night, startsAt: authority.startsAt, endsAt: authority.endsAt } };
  const bytes = Buffer.from(`${JSON.stringify(owner, null, 2)}\n`);
  // If publication fails, keep this directory quarantined. No child has run;
  // retained failed attempt identifies it for coordinator review.
  const fd = openSync(options.leaseFile, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(directory, 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
  return { token, ownerSHA256: sha256(bytes), release() {
    if (creation() !== started || readdirSync(directory).sort().join(',') !== 'owner.json'
      || sha256(readFileSync(options.leaseFile)) !== sha256(bytes)) throw new Error('nightly lease changed; quarantine rather than deleting another owner');
    unlinkSync(options.leaseFile); rmdirSync(directory);
  } };
}
