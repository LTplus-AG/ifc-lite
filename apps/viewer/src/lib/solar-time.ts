/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Display-frame time helpers for the solar study.
 *
 * The studied instant is always stored as an absolute UTC epoch. For display
 * the UI defaults to *local solar time* derived from the site longitude
 * (15°/hour) — civil-timezone-agnostic on purpose, since sun-path studies
 * care about solar time and a longitude offset needs no timezone database or
 * DST rules. The user can switch the readout to UTC.
 */

export const MS_PER_MIN = 60_000;
export const MS_PER_DAY = 86_400_000;

/** Longitude → display offset in minutes (local solar time), or 0 for UTC. */
export function solarDisplayOffsetMinutes(useLocal: boolean, longitude: number | undefined): number {
  if (!useLocal || longitude === undefined) return 0;
  return Math.round((longitude / 15) * 60);
}

/** Epoch ms shifted into the display frame (UTC + offset). */
export function toSolarDisplay(ms: number, offsetMin: number): Date {
  return new Date(ms + offsetMin * MS_PER_MIN);
}

/** "YYYY-MM-DD" of the display-frame day for an instant. */
export function toSolarDateInputValue(ms: number, offsetMin: number): string {
  const d = toSolarDisplay(ms, offsetMin);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/** Minutes since midnight in the display frame. */
export function solarMinutesOfDay(ms: number, offsetMin: number): number {
  const d = toSolarDisplay(ms, offsetMin);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Compose an absolute UTC epoch from a display-frame date string + minutes. */
export function composeSolarMs(dateStr: string, minutes: number, offsetMin: number): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const displayMs = Date.UTC(y, (m ?? 1) - 1, d ?? 1, Math.floor(minutes / 60), minutes % 60, 0);
  return displayMs - offsetMin * MS_PER_MIN;
}

/** Epoch ms → "HH:MM" in the display frame. */
export function formatSolarTime(ms: number | null, offsetMin: number): string {
  if (ms === null) return '—';
  const d = toSolarDisplay(ms, offsetMin);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
