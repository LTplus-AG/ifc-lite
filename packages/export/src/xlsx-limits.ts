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
const XLSX_MAX_SHEET_NAME = 31;
/** Excel's maximum characters in one cell. */
const XLSX_MAX_CELL_CHARS = 32767;

// Excel sheet names cannot contain ASCII controls.
// eslint-disable-next-line no-control-regex
const ILLEGAL_SHEET_CHARS = /[\\/?*[\]:\u0000-\u001f]/g;
const OUTER_SHEET_CHARS = /^[\s']+|[\s']+$/g;

function trimSheetName(name: string): string {
  const clean = name.replace(ILLEGAL_SHEET_CHARS, '-').replace(OUTER_SHEET_CHARS, '');
  return clean.slice(0, XLSX_MAX_SHEET_NAME)
    .replace(/[\uD800-\uDBFF]$/, '')
    .replace(OUTER_SHEET_CHARS, '');
}

/**
 * A name for the single worksheet in an XLSX export. Replaces illegal
 * characters, removes outer apostrophes, and fits within 31 UTF-16 units
 * without splitting a surrogate pair. Excel reserves the name History.
 */
export function sanitizeSheetName(name: string, fallback = 'Sheet1'): string {
  const base = trimSheetName(name) || trimSheetName(fallback) || 'Sheet1';
  return base.toLowerCase() === 'history' ? `${base} (1)` : base;
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
