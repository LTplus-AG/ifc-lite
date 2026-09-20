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

export function localeCount(locale: string, count: number): { count: number; countDisplay: string } {
  return { count, countDisplay: formatLocaleNumber(locale, count) };
}

/** Parse a number written with the active locale's digits and separators. */
export function parseLocaleNumber(locale: string, input: string): number | null {
  const canonicalLocale = supportedLocale(locale);
  const formatter = new Intl.NumberFormat(canonicalLocale, { useGrouping: true });
  const parts = formatter.formatToParts(-12345.6);
  const group = parts.find((part) => part.type === 'group')?.value;
  const decimal = parts.find((part) => part.type === 'decimal')?.value ?? '.';
  const minus = parts.find((part) => part.type === 'minusSign')?.value ?? '-';
  const digitFormatter = new Intl.NumberFormat(canonicalLocale, { useGrouping: false });
  const digits = new Map(
    Array.from({ length: 10 }, (_, digit) => [digitFormatter.format(digit), String(digit)]),
  );
  let normalized = input.trim().replace(/[\u200e\u200f\u061c]/g, '');
  for (const [localized, ascii] of digits) normalized = normalized.replaceAll(localized, ascii);
  if (group) normalized = normalized.replaceAll(group, '');
  normalized = normalized.replaceAll(decimal, '.').replaceAll(minus, '-');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function formatLocaleList(locale: string, values: readonly string[]): string {
  return new Intl.ListFormat(supportedLocale(locale), { style: 'long', type: 'conjunction' }).format(values);
}

export function formatLocaleDate(
  locale: string,
  value: number | Date,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(supportedLocale(locale), options).format(value);
}
