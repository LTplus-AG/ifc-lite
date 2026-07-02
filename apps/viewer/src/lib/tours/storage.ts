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
  tours: Record<string, TourRecord>;
}

function read(): TourStorage {
  if (typeof window === 'undefined') return { tours: {} };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tours: {} };
    const parsed = JSON.parse(raw) as Partial<TourStorage>;
    return { inviteDismissedAt: parsed.inviteDismissedAt, tours: parsed.tours ?? {} };
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
