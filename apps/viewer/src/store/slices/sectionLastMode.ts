/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section tool's last-used mode, round-tripped through localStorage
 * (issue #243 follow-up). Its own module (#5513) so the box slice and the
 * plane slice both write it without importing each other.
 */

import type { SectionPlaneAxis } from '../types.js';

// Last-used section mode (issue #243 follow-up). When the user reopens
// the section tool we restore whichever mode they used last:
//   • 'pick'     — face-pick is rearmed (default for first-time users
//                  and anyone whose last action was a face pick).
//   • 'cardinal' — restore the previous axis + position + flipped so the
//                  cut appears exactly where they left it.
//   • 'box'      — the user was cutting with a section box (#5513); the
//                  box itself is model-relative and is not persisted.
// Custom (face-picked) planes are NOT persisted: they're tied to the
// loaded model's world coordinates and would land somewhere meaningless
// on a different model. Re-arming pick mode lets the user re-cut the
// equivalent face on the new model with one click.
//
// 'cardinal' IS geometry — its `position` is only meaningful relative to
// the bounding box of whatever model is loaded — but it round-trips
// through localStorage (survives closing the browser), not just the
// in-memory store (which `resetViewerState` already clears on every file
// load). Without an explicit clear, a browser-session reload that opens a
// DIFFERENT model would read yesterday's cardinal position from
// localStorage and immediately apply it to today's model — the tool
// looked like it "pre-chose" a cut instead of arming pick mode (#2939).
// `resetViewerState()` (store/index.ts) calls `clearLastSectionMode()`
// below on every primary file load for exactly this reason: it is the
// same reset that already zeroes the in-memory axis/position/flipped
// fields, so both copies of this state are dropped together.
const SECTION_MODE_STORAGE_KEY  = 'ifc-lite:section-last-mode';

export type LastSectionMode =
  | { kind: 'pick' | 'box' }
  | { kind: 'cardinal'; axis: SectionPlaneAxis; position: number; flipped: boolean };

const DEFAULT_LAST_MODE: LastSectionMode = { kind: 'pick' };

function isSectionPlaneAxis(v: unknown): v is SectionPlaneAxis {
  return v === 'down' || v === 'front' || v === 'side';
}

export function loadLastSectionMode(): LastSectionMode {
  if (typeof window === 'undefined') return DEFAULT_LAST_MODE;
  try {
    const raw = window.localStorage.getItem(SECTION_MODE_STORAGE_KEY);
    if (!raw) return DEFAULT_LAST_MODE;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed?.kind === 'pick' || parsed?.kind === 'box') return { kind: parsed.kind };
    if (
      parsed?.kind === 'cardinal' &&
      isSectionPlaneAxis(parsed.axis) &&
      typeof parsed.position === 'number' && Number.isFinite(parsed.position) &&
      typeof parsed.flipped === 'boolean'
    ) {
      // Clamp position to the same [0, 100] range the slice enforces so
      // a tampered or stale value can't poison the slider on restore.
      const position = Math.min(100, Math.max(0, parsed.position));
      return { kind: 'cardinal', axis: parsed.axis, position, flipped: parsed.flipped };
    }
    return DEFAULT_LAST_MODE;
  } catch {
    // Corrupted JSON or storage exception — fall back to the default
    // pick mode silently. We don't warn here because this runs on every
    // panel mount and would spam the console for any user with bad data.
    return DEFAULT_LAST_MODE;
  }
}

export function saveLastSectionMode(mode: LastSectionMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SECTION_MODE_STORAGE_KEY, JSON.stringify(mode));
  } catch {
    // Quota exceeded / private mode — best effort, the preference just
    // doesn't survive this session.
  }
}

export function clearLastSectionMode(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SECTION_MODE_STORAGE_KEY);
  } catch { /* best-effort */ }
}
