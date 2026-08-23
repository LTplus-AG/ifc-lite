/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the CSV-cell cross-language parity pin.
 *
 * The Rust escaper (`rust/export/src/csv_cell.rs`, exercised by
 * `rust/export/tests/csv_cell_parity.rs`) is held to the SAME fixture, so the
 * two implementations cannot drift apart silently. Follows the precedent set
 * by `unit_scale_parity.rs` / `unit-scale.parity.test.ts` for the length-unit
 * extractors.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeCsvCell, INVISIBLE_PREFIX_RE, PADDING_RE, type CsvCellOptions } from './csv-cell.js';

interface Vector {
  name: string;
  input: string;
  expected: string;
  /** Column delimiter; defaults to `,`. */
  delimiter?: string;
  /** Exempt a cell that is wholly a signed number from the `+`/`-` trigger. */
  exemptNumbers?: boolean;
  /** Quote a cell whose first or last character is whitespace. */
  quoteWhitespacePadded?: boolean;
}

interface Fixture {
  invisiblePrefixRanges: [number, number][];
  paddingRanges: [number, number][];
  cases: Vector[];
}

// The fixture lives in the Rust crate so `include_str!` can reach it; this side
// resolves it relative to the source file. NOT guarded by `existsSync`: a
// missing fixture means the pin is not being enforced, which must fail loudly.
const fixturePath = fileURLToPath(
  new URL('../../../rust/export/tests/fixtures/csv_cell_vectors.json', import.meta.url),
);
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

describe('escapeCsvCell matches the shared cross-language vectors', () => {
  it('the fixture actually carries cases (an empty sweep proves nothing)', () => {
    expect(fixture.cases.length).toBeGreaterThan(20);
    expect(fixture.invisiblePrefixRanges.length).toBeGreaterThan(0);
  });

  for (const v of fixture.cases) {
    it(`vector: ${v.name}`, () => {
      // An ABSENT field means "whatever the library defaults to", not a
      // hard-coded value. Spelling the defaults out here made the harness blind
      // to the one thing it exists to catch: the two languages' defaults
      // drifting apart. Vectors that name no options at all therefore pin the
      // TS and Rust defaults against each other.
      // Start EMPTY, not `{ delimiter: ',' }`: spelling the delimiter out meant
      // no vector ever exercised the TypeScript delimiter default, so it could
      // drift from Rust's unnoticed. Same reasoning as the options below.
      const opts: CsvCellOptions = {};
      if (v.delimiter !== undefined) opts.delimiter = v.delimiter;
      if (v.exemptNumbers !== undefined) opts.exemptNumbers = v.exemptNumbers;
      if (v.quoteWhitespacePadded !== undefined) {
        opts.quoteWhitespacePadded = v.quoteWhitespacePadded;
      }
      const got = escapeCsvCell(v.input, opts);
      expect(got).toBe(v.expected);
    });
  }
});

describe('the invisible-prefix class agrees with the table Rust is pinned to', () => {
  /**
   * Sweeps EVERY code point rather than sampling: the guard's whole failure
   * mode is one unlisted invisible acting as a bypass, so a sample is exactly
   * the wrong shape of test. If this fails after a Node upgrade, that is real
   * drift between the engine's Unicode tables and Rust's const table — fix the
   * table (and regenerate the fixture deliberately), never the assertion.
   */
  function sweep(ranges: [number, number][], re: RegExp): string[] {
    let ri = 0;
    const mismatches: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates: category Cs
      while (ri < ranges.length && ranges[ri][1] < cp) ri++;
      const inTable = ri < ranges.length && cp >= ranges[ri][0] && cp <= ranges[ri][1];
      const inRegex = re.test(String.fromCodePoint(cp));
      if (inTable !== inRegex && mismatches.length < 10) {
        mismatches.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}: regex=${inRegex} table=${inTable}`);
      }
    }
    return mismatches;
  }

  it('every code point 0..=0x10FFFF classifies the same on both sides', () => {
    expect(sweep(fixture.invisiblePrefixRanges, INVISIBLE_PREFIX_RE)).toEqual([]);
  });

  /**
   * The padding class for `quoteWhitespacePadded`. JS `\s` and Rust's
   * `char::is_whitespace` are NOT the same set — JS has U+FEFF and lacks
   * U+0085, White_Space is the reverse — so the Rust side carries an explicit
   * carve-out. This sweep is what keeps the two spellings equal.
   */
  it('the padding class agrees with the table Rust is pinned to', () => {
    expect(sweep(fixture.paddingRanges, PADDING_RE)).toEqual([]);
    expect(PADDING_RE.test('\uFEFF'), 'JS \\s includes the BOM').toBe(true);
    expect(PADDING_RE.test('\u0085'), 'JS \\s excludes NEL').toBe(false);
  });

  it('both tables are sorted, non-overlapping and non-adjacent', () => {
    for (const ranges of [fixture.invisiblePrefixRanges, fixture.paddingRanges]) {
      for (let i = 0; i < ranges.length; i++) {
        expect(ranges[i][0]).toBeLessThanOrEqual(ranges[i][1]);
        // Adjacency would mean the generator emitted a splittable range, which
        // makes a hand-edit of the table silently ambiguous.
        if (i > 0) expect(ranges[i][0]).toBeGreaterThan(ranges[i - 1][1] + 1);
      }
    }
  });

  it('pins the named bypasses that motivated the class (#1944 and follow-ups)', () => {
    // Spelled out so a table regeneration that dropped one of these is caught
    // by name rather than by a code-point number in a diff.
    for (const [label, ch] of [
      ['BOM U+FEFF', '﻿'],
      ['ZWSP U+200B', '​'],
      ['LRM U+200E', '‎'],
      ['NBSP U+00A0', ' '],
      ['LINE SEPARATOR U+2028', ' '],
      ['PARAGRAPH SEPARATOR U+2029', ' '],
      ['SPACE U+0020', ' '],
    ] as const) {
      expect(INVISIBLE_PREFIX_RE.test(ch), label).toBe(true);
      expect(escapeCsvCell(`${ch}=cmd`)).toBe(`'${ch}=cmd`);
    }
    // TAB is NOT in the class: it is itself a trigger, so skipping past it
    // would un-guard "\t=cmd" — the exact trap `\s` would have walked into.
    expect(INVISIBLE_PREFIX_RE.test('\t')).toBe(false);
  });
});
