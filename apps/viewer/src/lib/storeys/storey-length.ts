/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Typed storey lengths (#9013). People type levels the way drawings write
 * them: `3`, `3.00`, `3,5`, `+3.50 m`, `3500 mm`, `350 cm`, `−0.40`. All of
 * them read as metres. The unit symbols are symbols, not copy, so they are not
 * translated.
 */

const UNITS: Readonly<Record<string, number>> = { m: 1, cm: 0.01, mm: 0.001 };
const PATTERN = /^([+\-−–]?)\s*(\d+(?:[.,]\d*)?|[.,]\d+)\s*(m|cm|mm)?$/i;

/** Metres, or null when the text is not a length. `signed: false` refuses a minus. */
export function parseStoreyLength(text: string, options: { signed: boolean }): number | null {
  const match = PATTERN.exec(text.trim().replace(/\s+/g, ' '));
  if (!match) return null;
  const [, sign, digits, unit] = match;
  const negative = sign !== '' && sign !== '+';
  if (negative && !options.signed) return null;
  const value = Number(digits.replace(',', '.')) * UNITS[(unit ?? 'm').toLowerCase()];
  if (!Number.isFinite(value)) return null;
  return Math.round((negative ? -value : value) * 1e6) / 1e6;
}

/** `+3.00`, `−0.40`, `±0.00`: the storey picker's convention, without the unit. */
export function formatElevation(metres: number): string {
  const rounded = Math.round(metres * 1000) / 1000;
  if (rounded === 0) return '±0.00';
  const digits = Math.abs(rounded).toFixed(Number.isInteger(rounded * 100) ? 2 : 3);
  return `${rounded > 0 ? '+' : '−'}${digits}`;
}

/** `3.00`, `3.125`: a positive height, without the unit. */
export function formatHeight(metres: number): string {
  const rounded = Math.round(metres * 1000) / 1000;
  return rounded.toFixed(Number.isInteger(rounded * 100) ? 2 : 3);
}
