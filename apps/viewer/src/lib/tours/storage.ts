/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tour persistence: which tours were completed (and at which content
 * version), and whether the first-run invite was dismissed. Same contract
 * as `usePrivacyDisclosure`: localStorage reads/writes are best-effort
 * (privacy modes throw), a version bump means a new key.
 */

import type { TourId } from './types';

const STORAGE_KEY = 'ifc-lite:tours:v1';

interface TourRecord {
  completedAt?: string;
  completedVersion?: number;
  lastStepIndex?: number;
  abortCount?: number;
}

interface TourStorage {
  inviteDismissedAt?: string;
  /** One-time UI notices (what-changed lines), by notice id. */
  notices?: Record<string, string>;
  tours: Record<string, TourRecord>;
}

/** A plain, non-array object — the shape every field below needs before its
 *  own properties are trusted. `??` alone only rescues null/undefined, so a
 *  wrong-typed-but-present value (a string, a number, an array) would
 *  otherwise sail through unchanged; downstream writers (`s.tours[id] = …`)
 *  then throw assigning a property onto a primitive. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function read(): TourStorage {
  if (typeof window === 'undefined') return { tours: {} };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tours: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return { tours: {} };
    return {
      inviteDismissedAt: typeof parsed.inviteDismissedAt === 'string' ? parsed.inviteDismissedAt : undefined,
      notices: isPlainObject(parsed.notices) ? (parsed.notices as Record<string, string>) : {},
      tours: isPlainObject(parsed.tours) ? (parsed.tours as Record<string, TourRecord>) : {},
    };
  } catch {
    // Privacy modes throw on localStorage access and malformed JSON is not
    // worth surfacing - both degrade to "no tour history".
    return { tours: {} };
  }
}

function write(next: TourStorage): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota / private mode - the flag just won't persist this session.
  }
}

export function isInviteDismissed(): boolean {
  return Boolean(read().inviteDismissedAt);
}

export function dismissInvite(): void {
  const s = read();
  s.inviteDismissedAt = new Date().toISOString();
  write(s);
}

/**
 * One-time notices ("this part of the UI changed"). Same best-effort
 * contract as the invite: a browser that cannot store just shows it again.
 */
export function isNoticeDismissed(id: string): boolean {
  return Boolean(read().notices?.[id]);
}

export function dismissNotice(id: string): void {
  const s = read();
  s.notices = { ...(s.notices ?? {}), [id]: new Date().toISOString() };
  write(s);
}

/** Completed at (or past) the given content version. */
export function isTourCompleted(id: TourId, version: number): boolean {
  const rec = read().tours[id];
  return Boolean(rec?.completedAt) && (rec?.completedVersion ?? 0) >= version;
}

export function markTourCompleted(id: TourId, version: number): void {
  const s = read();
  const rec = s.tours[id] ?? {};
  rec.completedAt = new Date().toISOString();
  rec.completedVersion = version;
  s.tours[id] = rec;
  write(s);
}

export function markTourAborted(id: TourId, lastStepIndex: number): void {
  const s = read();
  const rec = s.tours[id] ?? {};
  rec.lastStepIndex = lastStepIndex;
  rec.abortCount = (rec.abortCount ?? 0) + 1;
  s.tours[id] = rec;
  write(s);
}
