/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Calendar prerequisite for #6975 calibration; never a hardware admission oracle. */
export interface NightAttempt {
  /** Scheduled UTC calendar day, retained even when launch/admission fails. */
  night: string;
  startedAt: string;
  finishedAt: string;
  profileSha256: string;
  status: 'ok' | 'refused' | 'failed';
  /** Hash of the immutable raw rig/admission artifact, not its summary. */
  receiptSha256: string;
}

const DAY_MS = 86_400_000;
const HASH = /^[a-f0-9]{64}$/;

function dayNumber(value: string): number {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed)
    || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error(`invalid scheduled UTC night: ${value}`);
  }
  return parsed / DAY_MS;
}

/** Refuse corrupt history; a malformed attempt must not disappear from calibration. */
export function decodeNightHistory(input: unknown): NightAttempt[] {
  if (!Array.isArray(input)) throw new Error('night history must be an array');
  for (const row of input) {
    if (!row || typeof row !== 'object') throw new Error('invalid night attempt');
    const night: unknown = Reflect.get(row, 'night');
    const started: unknown = Reflect.get(row, 'startedAt');
    const finished: unknown = Reflect.get(row, 'finishedAt');
    if (typeof night !== 'string') throw new Error('missing scheduled night');
    dayNumber(night);
    if (typeof started !== 'string' || typeof finished !== 'string'
      || !Number.isFinite(Date.parse(started)) || !Number.isFinite(Date.parse(finished))
      || Date.parse(finished) < Date.parse(started)) throw new Error('invalid attempt interval');
    if (new Date(started).toISOString().slice(0, 10) !== night) {
      throw new Error('attempt did not start on its scheduled UTC night');
    }
    for (const field of ['profileSha256', 'receiptSha256']) {
      const value: unknown = Reflect.get(row, field);
      if (typeof value !== 'string' || !HASH.test(value)) throw new Error(`invalid ${field}`);
    }
    if (!['ok', 'refused', 'failed'].includes(Reflect.get(row, 'status') as string)) {
      throw new Error('invalid night attempt status');
    }
  }
  return input as NightAttempt[];
}

export interface NightHistoryWindow {
  consecutive: NightAttempt[];
  calendarReady: boolean;
  reason: string;
}

/**
 * At most one attempt per night can contribute. Retries never replace refusals,
 * failed nights never vanish, and a profile change starts a new calibration.
 * `calendarReady` only permits review of seven raw artifacts; it cannot set a
 * threshold or establish that their physical-display/GPU admission was valid.
 */
export function nightHistoryWindow(history: readonly NightAttempt[], through: string): NightHistoryWindow {
  let day = dayNumber(through);
  const byDay = new Map<number, NightAttempt[]>();
  const receiptDays = new Map<string, Set<number>>();
  for (const attempt of decodeNightHistory(history)) {
    const key = dayNumber(attempt.night);
    byDay.set(key, [...(byDay.get(key) ?? []), attempt]);
    const days = receiptDays.get(attempt.receiptSha256) ?? new Set<number>();
    days.add(key);
    receiptDays.set(attempt.receiptSha256, days);
  }
  const consecutive: NightAttempt[] = [];
  let profile: string | undefined;
  let reason = 'seven consecutive raw nightly artifacts available for admission and threshold review';
  for (; consecutive.length < 7; day--) {
    const attempts = byDay.get(day);
    if (!attempts?.length) { reason = 'missing scheduled night'; break; }
    if (attempts.length !== 1) { reason = 'multiple attempts on one night'; break; }
    const attempt = attempts[0];
    if (attempt.status !== 'ok') { reason = `${attempt.status} scheduled night`; break; }
    if (profile !== undefined && attempt.profileSha256 !== profile) { reason = 'calibration profile changed'; break; }
    if (receiptDays.get(attempt.receiptSha256)!.size !== 1) {
      reason = 'raw receipt reused across nights'; break;
    }
    profile = attempt.profileSha256;
    consecutive.unshift(attempt);
  }
  return { consecutive, calendarReady: consecutive.length === 7, reason };
}
