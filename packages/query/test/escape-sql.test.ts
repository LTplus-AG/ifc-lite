/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { escapeSQL } from '../src/duckdb-integration.js';

// escapeSQL interpolates IFC strings (entity names, GlobalIds, property and
// quantity values, pset/qset names) directly into DuckDB INSERT statement
// text. It is exercised here directly rather than through the WASM-backed
// insert path, which requires a live DuckDB connection.
describe('escapeSQL', () => {
  it('leaves a value with no special characters unchanged', () => {
    expect(escapeSQL('Exterior Wall')).toBe('Exterior Wall');
  });

  it('doubles a single apostrophe in the middle of a value', () => {
    // e.g. a French/German description such as "L'entrée principale"
    expect(escapeSQL("L'entree")).toBe("L''entree");
  });

  it('doubles several apostrophes in one value', () => {
    expect(escapeSQL("'a'b'c'")).toBe("''a''b''c''");
  });

  it('doubles an apostrophe at the start of a value', () => {
    expect(escapeSQL("'leading")).toBe("''leading");
  });

  it('doubles an apostrophe at the end of a value', () => {
    expect(escapeSQL("trailing'")).toBe("trailing''");
  });

  it('doubles apostrophes in dimension notation like 5\' 6"', () => {
    expect(escapeSQL('5\' 6"')).toBe('5\'\' 6"');
  });

  it('returns an empty string unchanged', () => {
    expect(escapeSQL('')).toBe('');
  });

  it('returns an empty string for null', () => {
    expect(escapeSQL(null)).toBe('');
  });

  it('returns an empty string for undefined', () => {
    expect(escapeSQL(undefined)).toBe('');
  });

  it('leaves a backslash untouched', () => {
    // DuckDB's default SQL dialect (standard_conforming_strings) does not
    // treat backslash as an escape character inside a '...' string literal
    // — unlike MySQL — so a literal backslash needs no special handling here.
    expect(escapeSQL('C:\\path\\to\\file')).toBe('C:\\path\\to\\file');
  });
});
