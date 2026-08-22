/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `escapeCsvCell` — the one CSV cell writer behind every `export.csv`.
 *
 * It exists because five copies of it existed instead, and they had drifted:
 * only the SDK namespace's copy carried the #1944 invisible-prefix hardening,
 * so the same entity name exported guarded through `bim.export.csv()` and
 * UNGUARDED through `ifc-lite export --format csv`, the MCP server's
 * `export_csv` and the viewer's export adapter. Deleting the guard outright
 * from any of those three left every one of their tests green.
 *
 * These tests are the contract the four call sites now share. They are written
 * against the helper directly; the call sites each keep an end-to-end test that
 * the helper is actually reached.
 */

import { describe, it, expect } from 'vitest';
import { escapeCsvCell } from './csv-escape.js';

describe('escapeCsvCell — formula-injection guard (CWE-1236)', () => {
  it('prefixes a bare formula trigger so the cell reads as text', () => {
    for (const trigger of ['=', '+', '-', '@']) {
      expect(escapeCsvCell(`${trigger}HYPERLINK("http://evil")`, ',')).toMatch(/^"?'/);
    }
  });

  it('prefixes a trigger hidden behind an invisible character (#1944)', () => {
    const hidden: [string, string][] = [
      ['BOM', '\u{FEFF}'],
      ['zero-width space', '\u{200B}'],
      ['left-to-right mark', '\u{200E}'],
      ['right-to-left override', '\u{202E}'],
      ['non-breaking space', '\u{00A0}'],
    ];
    for (const [label, prefix] of hidden) {
      expect(escapeCsvCell(`${prefix}=HYPERLINK(http://evil)`, ','), label).toMatch(/^'/);
    }
  });

  /**
   * `\p{Zl}`/`\p{Zp}`, the two separator categories that `\p{Zs}` leaves out.
   * The SDK copy of the guard skipped `\p{Zs}` only, so U+2028 and U+2029 were
   * still viable hiding prefixes there — and neither is caught by the RFC 4180
   * quoting below, which only looks for `\n` and `\r`.
   */
  it('prefixes a trigger hidden behind U+2028 / U+2029', () => {
    expect(escapeCsvCell('\u{2028}=HYPERLINK(http://evil)', ',')).toMatch(/^'/);
    expect(escapeCsvCell('\u{2029}=HYPERLINK(http://evil)', ',')).toMatch(/^'/);
  });

  /**
   * TAB and CR are triggers in their own right, so "skip leading whitespace,
   * then look for a trigger" must not be written with `\s` — that would swallow
   * the tab and un-guard `"\thello"`, which the guard has always caught.
   */
  it('still guards a leading tab or carriage return on its own', () => {
    expect(escapeCsvCell('\thello', ',')).toBe("'\thello");
    expect(escapeCsvCell('\rhello', ',')).toBe('"\'\rhello"');
  });

  it('leaves ordinary values alone, invisible characters before text included', () => {
    expect(escapeCsvCell('Wall-001', ',')).toBe('Wall-001');
    expect(escapeCsvCell('\u{FEFF}Wall-001', ',')).toBe('\u{FEFF}Wall-001');
    expect(escapeCsvCell(' Wall-001', ',')).toBe(' Wall-001');
    expect(escapeCsvCell('', ',')).toBe('');
  });
});

describe('escapeCsvCell — RFC 4180 quoting', () => {
  it('quotes a value containing the active separator, and only that separator', () => {
    expect(escapeCsvCell('a,b', ',')).toBe('"a,b"');
    expect(escapeCsvCell('a,b', ';')).toBe('a,b');
    expect(escapeCsvCell('a;b', ';')).toBe('"a;b"');
  });

  it('quotes and doubles embedded double-quotes', () => {
    expect(escapeCsvCell('Has "quotes" inside', ',')).toBe('"Has ""quotes"" inside"');
  });

  it('quotes a value containing a newline', () => {
    expect(escapeCsvCell('Line1\nLine2', ',')).toBe('"Line1\nLine2"');
  });

  it('applies the apostrophe BEFORE quoting, so the guard survives the quotes', () => {
    // Both defenses fire: the apostrophe has to land inside the quoted field,
    // otherwise the spreadsheet strips the quotes and evaluates the formula.
    expect(escapeCsvCell('=SUM(A1,A2)', ',')).toBe('"\'=SUM(A1,A2)"');
  });
});
