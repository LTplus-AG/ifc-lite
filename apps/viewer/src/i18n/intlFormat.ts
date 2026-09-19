/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

function supportedLocale(locale: string): string {
  try {
    Intl.getCanonicalLocales(locale);
    return locale;
  } catch (error) {
    if (error instanceof RangeError) return 'en';
    throw error;
  }
}

export function formatLocaleNumber(locale: string, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(supportedLocale(locale), options).format(value);
}

export function formatLocaleList(locale: string, values: readonly string[]): string {
  return new Intl.ListFormat(supportedLocale(locale), { style: 'long', type: 'conjunction' }).format(values);
}
