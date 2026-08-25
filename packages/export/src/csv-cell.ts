/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isWhollyNumeric } from '@ifc-lite/encoding';

/**
 * THE CSV cell escaper for this repository's TypeScript.
 *
 * Every TS producer of CSV — SDK, CLI, MCP, viewer (search results, compare
 * report, lists, the local export adapter) — calls `escapeCsvCell` and nothing
 * else. Before this module there were nine hand-rolled copies and no two were
 * identical: some tested the formula trigger anchored at offset 0 (so a BOM,
 * ZWSP, LRM, NBSP or U+2028 in front of `=` walked straight past the guard),
 * some hardened it by DELETING the leading invisibles (which silently dropped
 * leading spaces from every exported cell, against RFC 4180 §2.4: "Spaces are
 * considered part of a field and should not be ignored"), and some hard-coded
 * a comma while their caller had a configurable delimiter.
 *
 * `scripts/check-csv-escaper-copies.mjs` (run by `pnpm run check:csv-escapers`)
 * fails the build if a tenth copy appears.
 *
 * The Rust half lives in `rust/export/src/csv_cell.rs`. Both are pinned to the
 * shared vectors in `rust/export/tests/fixtures/csv_cell_vectors.json`.
 */

/**
 * Code points a spreadsheet importer swallows, or renders as pure spacing, yet
 * which do NOT stop a following `=`/`+`/`-`/`@` from being evaluated as a
 * formula. Exactly Unicode general categories `Cf` (format — BOM U+FEFF, ZWSP
 * U+200B, LRM U+200E, the bidi controls …) plus `Z` (separator).
 *
 * `\p{Z}` rather than `\p{Zs}`: the separator category also covers `Zl` and
 * `Zp`, i.e. U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, which are
 * otherwise perfectly good places to hide a trigger.
 *
 * Deliberately NOT `\s`: `\s` matches TAB, and TAB is itself a trigger — so
 * skipping past it would un-guard `"\t=cmd"`.
 *
 * Exported for the parity sweep, which checks this class against the const
 * range table the Rust side carries, code point by code point.
 */
export const INVISIBLE_PREFIX_RE = /[\p{Cf}\p{Z}]/u;

/**
 * A cell whose first VISIBLE character is one of these is evaluated as a
 * formula by Excel / LibreOffice / Google Sheets (CWE-1236). IFC text values
 * are attacker-controllable, so such a cell is prefixed with an apostrophe,
 * which those importers strip while forcing the cell to be read as text.
 */
const TRIGGER_RE = /^[\p{Cf}\p{Z}]*[=+\-@\t\r]/u;

export interface CsvCellOptions {
  /** Column delimiter the cell will be joined with. Default `,`. */
  delimiter?: string;
  /**
   * Exempt a cell that is wholly a signed number (`-0.35`, `+1`, `-1.5e-3`)
   * from the `+`/`-` formula trigger, so spreadsheet `SUM()` still works on
   * exported measures (#1772). **Default `true`.**
   *
   * A PRODUCT policy, not a security one. The exemption cannot weaken the
   * guard: the accepted language is built from `+ - . e E 0-9` and nothing
   * else, which cannot spell a function name, a cell reference or a `(`, so
   * every string it exempts is inert in a spreadsheet. `=`, `@`, TAB and CR are
   * never exempted, and a number with anything glued to it (`-0.35=cmd`) is not
   * wholly numeric and stays guarded.
   *
   * The default used to be `false`, which made the repo disagree with itself:
   * `@ifc-lite/lists` exempted numbers, every other writer guarded them, and
   * both behaviours were deliberately tested. Exempting is now the default so
   * the policy lives in ONE place instead of at eleven call sites, where it
   * would drift. Pass `false` to opt a writer out.
   *
   * This flag does NOT make a numeric column sum on its own; a cell that
   * arrives already display-formatted is not wholly numeric and no setting here
   * changes that. `apps/viewer/src/lib/lists/export/csv.ts` explains why.
   */
  exemptNumbers?: boolean;
  /**
   * Also quote a cell whose first or last character is whitespace, so an
   * importer that would otherwise trim the padding cannot (RFC 4180 §2.4 again,
   * from the other side). Used by the zones-table writer. Default `false`.
   *
   * "Whitespace" here is JavaScript `\s` — deliberately pinned as an explicit
   * table in the shared fixture, because JS `\s` and Rust
   * `char::is_whitespace` are NOT the same set (JS has U+FEFF and lacks U+0085;
   * White_Space is the reverse), and that asymmetry is exactly the kind of
   * thing that becomes a silent cross-language split.
   */
  quoteWhitespacePadded?: boolean;
}

/**
 * Whitespace for the `quoteWhitespacePadded` rule: JavaScript `\s`. Exported
 * for the parity sweep that pins it against the Rust table.
 */
export const PADDING_RE = /\s/u;

/**
 * Neutralise spreadsheet formula injection in one cell, WITHOUT CSV quoting.
 *
 * Split out for writers whose container does its own escaping — the XLSX
 * writer needs the guard but must not gain CSV quotes. CSV writers want
 * {@link escapeCsvCell}, which is this plus RFC 4180 quoting.
 *
 * NON-DESTRUCTIVE: it looks *past* any leading invisibles rather than deleting
 * them, so the apostrophe lands in front of a payload that hid behind a BOM
 * while a benign `"   Wall A"` keeps its spaces.
 */
export function guardSpreadsheetFormula(
  value: string,
  options: Pick<CsvCellOptions, 'exemptNumbers'> = {},
): string {
  const { exemptNumbers = true } = options;
  if (!TRIGGER_RE.test(value)) return value;
  if (exemptNumbers && isWhollyNumeric(value)) return value;
  return `'${value}`;
}

/**
 * Escape one CSV cell: neutralise spreadsheet formula injection, then apply
 * RFC 4180 quoting.
 *
 * Quoting is applied after the guard so a value that both starts with a
 * trigger and contains the delimiter still gets wrapped.
 */
export function escapeCsvCell(value: string, options: CsvCellOptions = {}): string {
  const delimiter = options.delimiter ?? ',';
  const s = guardSpreadsheetFormula(value, options);

  const padded =
    options.quoteWhitespacePadded === true &&
    s.length > 0 &&
    (PADDING_RE.test(s[0]) || PADDING_RE.test(s[s.length - 1]));

  if (padded || s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
