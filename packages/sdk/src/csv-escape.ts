/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The single CSV cell writer for every `export.csv` implementation.
 *
 * Five byte-similar copies of this function used to exist — `ExportNamespace`
 * here, the CLI's `export` command, the CLI's headless backend, the MCP
 * headless backend and the viewer's export adapter — all of them behind the
 * SAME user-facing surface (`bim.export.csv()` / `ifc-lite export --format
 * csv`), and nothing made them agree. They had already drifted: only this one
 * carried the #1944 hardening, so the same malicious entity name exported
 * guarded through the SDK namespace and UNGUARDED through the CLI, the MCP
 * server and the viewer's adapter. Deleting the guard outright from any of the
 * other four left all of their tests green.
 *
 * Import this instead of writing a sixth copy.
 */

/**
 * Escape one CSV cell: neutralise spreadsheet formula injection (CWE-1236),
 * then apply RFC 4180 quoting.
 *
 * The formula trigger (`=`, `+`, `-`, `@`, TAB, CR) is looked for PAST any
 * leading invisible characters. A BOM, zero-width space, left-to-right mark or
 * non-breaking space in front of `=` does not stop a spreadsheet reading the
 * cell as a formula, but it does stop an anchored regex matching, so a BOM
 * followed by `=HYPERLINK(...)` used to sail through. IFC text properties are
 * author-controlled and survive round-trips, so a model can carry any of them.
 *
 * `\p{Cf}` (format) and `\p{Z}` (separator) deliberately, NOT `\s`: `\s` would
 * swallow a leading tab, and tab is itself a trigger, so `"\thello"` would stop
 * being guarded. `\p{Z}` rather than `\p{Zs}` so that U+2028 LINE SEPARATOR and
 * U+2029 PARAGRAPH SEPARATOR (categories Zl/Zp, neither of them matched by the
 * `\n`/`\r` quoting check below) cannot serve as the hiding prefix either.
 *
 * NOT the whole story for CSV in this repo, stated plainly: `@ifc-lite/lists`'
 * `listResultToCSV` deliberately EXEMPTS a plain number from the `-`/`+`
 * trigger (#1772 — `'-0.35` broke Excel `SUM()`), while the viewer's Lists
 * exporter deliberately guards it, and both behaviours are pinned by tests.
 * That divergence is a product decision and is not resolved here; this helper
 * covers the five `export.csv` copies, which had no such disagreement.
 *
 * @param value - Raw cell text.
 * @param sep - The delimiter the row is joined with.
 */
export function escapeCsvCell(value: string, sep: string): string {
  let str = value;
  if (/^[\p{Cf}\p{Z}]*[=+\-@\t\r]/u.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(sep) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
