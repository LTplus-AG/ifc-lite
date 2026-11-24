/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Excel's hard limits for an `.xlsx` workbook, shared by every TypeScript
 * writer. The `exceljs` writer enforces none of them gracefully: an illegal
 * character in a sheet name makes `addWorksheet` THROW (the whole export fails
 * for a list called "Rooms [Draft]"), and a cell over 32,767 characters is
 * written verbatim, which Excel answers with "We found a problem with some
 * content ... Do you want us to try to recover as much as we can?".
 */

/** Excel's maximum worksheet-name length. */
export const XLSX_MAX_SHEET_NAME = 31;
/** Excel's maximum characters in one cell. */
export const XLSX_MAX_CELL_CHARS = 32767;

const ILLEGAL_SHEET_CHARS = /[\\/?*[\]:\u0000-\u001f]/g;

/** Whole code points of `text` whose UTF-16 length stays within `units`: Excel counts UTF-16 units, and an emoji is two. */
function takeUtf16Units(text: string, units: number): string {
  let out = '';
  for (const point of text) {
    if (out.length + point.length > units) break;
    out += point;
  }
  return out;
}

function fit(base: string, suffix: string): string {
  return `${takeUtf16Units(base, XLSX_MAX_SHEET_NAME - suffix.length).trimEnd()}${suffix}`;
}

/**
 * A worksheet name Excel accepts, derived deterministically from `name`:
 * illegal characters (`\ / ? * [ ] :` and controls) become `-`, leading and
 * trailing apostrophes are dropped, the result is cut to 31 UTF-16 units (Excel's measure; whole code points only), an
 * empty result becomes `fallback`, and the reserved name `History` is
 * suffixed. Excel compares names case-insensitively, so when the result
 * collides with one in `taken` a ` (2)`, ` (3)` ... suffix is appended
 * (shrinking the base so the total stays within 31).
 */
export function sanitizeSheetName(name: string, taken: Iterable<string> = [], fallback = 'Sheet1'): string {
  const used = new Set(Array.from(taken, (t) => t.toLowerCase()));
  let base = name.replace(ILLEGAL_SHEET_CHARS, '-').replace(/^'+|'+$/g, '').trim();
  base = takeUtf16Units(base, XLSX_MAX_SHEET_NAME).trimEnd().replace(/^'+|'+$/g, '');
  if (!base) base = fallback;
  if (base.toLowerCase() === 'history') base = fit(base, ' (1)');
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = fit(base, ` (${n})`);
  return candidate;
}

/**
 * `text` cut to Excel's per-cell limit, ending in an ellipsis when cut so the
 * truncation is visible rather than silent.
 */
export function clampXlsxCellText(text: string): string {
  if (text.length <= XLSX_MAX_CELL_CHARS) return text;
  let end = XLSX_MAX_CELL_CHARS - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // never split a surrogate pair
  return `${text.slice(0, end)}…`;
}
