/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "When was this opened" for the start screen's recent list: relative while it
 * is recent ("5 minutes ago", "yesterday"), a short date after a week. Intl
 * does the wording, so every locale gets its own grammar.
 */

import { formatLocaleDate } from '@/i18n/intlFormat';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function recentWhen(locale: string, timestamp: number, now: number): string {
  const age = Math.max(0, now - timestamp);
  if (age < 7 * DAY) {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (age < HOUR) return rtf.format(-Math.max(1, Math.round(age / MINUTE)), 'minute');
    if (age < DAY) return rtf.format(-Math.round(age / HOUR), 'hour');
    return rtf.format(-Math.round(age / DAY), 'day');
  }
  return formatLocaleDate(locale, timestamp, { day: 'numeric', month: 'short' });
}

/** The file's extension as a short badge ("IFC", "E57"), or "" when it has none. */
export function formatBadge(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : '';
}
