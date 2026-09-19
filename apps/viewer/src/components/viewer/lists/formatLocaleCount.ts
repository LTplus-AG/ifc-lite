/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Format list counts with the active UI locale, tolerating test pseudo-locales. */
export function formatLocaleCount(value: number, locale: string): string {
  try {
    return value.toLocaleString(locale);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return value.toLocaleString('en');
  }
}

/** Format a user-facing list with the active UI locale. */
export function formatLocaleList(values: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(values);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(values);
  }
}
