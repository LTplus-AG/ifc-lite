/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Format extension metadata with the viewer locale, tolerating test-only locale ids. */
export function formatExtensionDate(value: string | number | Date, locale: string, dateOnly = false): string {
  const date = new Date(value);
  try {
    return dateOnly ? date.toLocaleDateString(locale) : date.toLocaleString(locale);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return dateOnly ? date.toLocaleDateString('en') : date.toLocaleString('en');
  }
}
