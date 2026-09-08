/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * RFC 4180 conformance for `listResultToCSV`, checked against the format's own
 * authority instead of against ourselves.
 *
 * WHY THIS FILE EXISTS. Every other CSV test in this repo asserts that our
 * writer produced the bytes we expected it to produce. That cannot see a rule
 * neither the writer nor the assertion knows about. So this file brings in two
 * outside references:
 *
 *   1. RFC 4180 ("Common Format and MIME Type for CSV Files", October 2005).
 *      `scanRfc4180` below is a transcription of the RFC's own ABNF grammar --
 *      not of our writer -- so it fails on output the RFC does not describe,
 *      even where our writer thinks it is right. Rules quoted verbatim from the
 *      RFC are marked [RFC 4180 sN] at each check.
 *   2. `csv-parse` (MIT, pinned 7.0.2, devDependency, no transitive deps), an
 *      independent third-party parser. Round-tripping through SOMEONE ELSE's
 *      parser is what catches a cell our writer mangles in a way our reader
 *      would happily mangle back.
 *
 * The two are cross-checked against each other (`agrees with an independent
 * parser`): if the hand-written grammar scanner and csv-parse disagree about
 * how many records or fields our output has, the scanner is wrong and this
 * whole file is untrustworthy -- so that disagreement is itself a failure.
 *
 * WHAT THIS FILE DOES *NOT* COVER, deliberately:
 *   - Quoting MINIMALITY. [RFC 4180 s2.5] "Each field may or may not be
 *     enclosed in double quotes", so quoting a field that did not need it is
 *     conformant. Nothing here asserts we quote as little as possible.
 *   - The strict TEXTDATA range. The ABNF says `non-escaped = *TEXTDATA` with
 *     `TEXTDATA = %x20-21 / %x23-2B / %x2D-7E`, i.e. printable ASCII only, so
 *     an unquoted field containing "u", "EUR" or a TAB is technically outside
 *     the grammar. Every real consumer accepts UTF-8 there, and the RFC itself
 *     registers a `charset` parameter in s3 expecting non-ASCII payloads, so
 *     `scanRfc4180` accepts any character that is not DQUOTE/COMMA/CR/LF in a
 *     non-escaped field. Flagging otherwise would be noise, not a defect.
 *   - Non-comma delimiters. RFC 4180 defines `COMMA = %x2C` and nothing else;
 *     `listResultToCSV(result, ';')` is outside the RFC entirely. The
 *     `delimiter` describe block below checks it with csv-parse only, and makes
 *     no RFC claim about it.
 *   - Encoding, BOM, and MIME headers. This file inspects a JS string; how it
 *     reaches a disk or an HTTP response is not observed here.
 *   - Whether the VALUES are semantically right (units, rounding, grouping).
 *     That is `engine.test.ts` / `engine.values.test.ts`. This file only asks
 *     whether the bytes we emit say what we meant, to a stranger.
 */

import { describe, it, expect } from 'vitest';
import { parse } from 'csv-parse/sync';
import { listResultToCSV } from './engine.js';
import type { ListResult, ColumnDefinition, CellValue } from './types.js';

// ---------------------------------------------------------------------------
// An RFC 4180 grammar scanner, transcribed from the RFC's ABNF.
// ---------------------------------------------------------------------------

/**
 * RFC 4180 ABNF, quoted verbatim from the RFC:
 *
 *   file        = [header CRLF] record *(CRLF record) [CRLF]
 *   header      = name *(COMMA name)
 *   record      = field *(COMMA field)
 *   name        = field
 *   field       = (escaped / non-escaped)
 *   escaped     = DQUOTE *(TEXTDATA / COMMA / CR / LF / 2DQUOTE) DQUOTE
 *   non-escaped = *TEXTDATA
 *   COMMA       = %x2C
 *   CR          = %x0D
 *   DQUOTE      = %x22
 *   LF          = %x0A
 *   CRLF        = CR LF
 *
 * Returns the records it managed to read plus every violation it saw. It keeps
 * scanning after a violation so one call reports everything wrong with a
 * document, not just the first thing.
 */
function scanRfc4180(text: string): { records: string[][]; violations: string[] } {
  const violations: string[] = [];
  const records: string[][] = [];
  let i = 0;

  if (text.length === 0) return { records, violations };

  for (;;) {
    const record: string[] = [];
    // record = field *(COMMA field)
    for (;;) {
      if (text[i] === '"') {
        // escaped = DQUOTE *(TEXTDATA / COMMA / CR / LF / 2DQUOTE) DQUOTE
        i++;
        let value = '';
        let closed = false;
        while (i < text.length) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              value += '"';
              i += 2;
              continue;
            }
            i++;
            closed = true;
            break;
          }
          value += text[i++];
        }
        if (!closed) {
          violations.push(
            `[RFC 4180 s2.7] escaped field starting at offset ${i} is never closed by a DQUOTE`,
          );
        }
        // After a closing DQUOTE the grammar allows only COMMA, CRLF or EOF.
        if (i < text.length && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
          violations.push(
            `[RFC 4180 s2.5] character ${JSON.stringify(text[i])} at offset ${i} follows a ` +
              `closing DQUOTE; an escaped field must end the field`,
          );
        }
        record.push(value);
      } else {
        // non-escaped = *TEXTDATA. TEXTDATA excludes DQUOTE, COMMA, CR and LF.
        let value = '';
        while (i < text.length && !',\r\n'.includes(text[i])) {
          if (text[i] === '"') {
            violations.push(
              `[RFC 4180 s2.5] DQUOTE at offset ${i} inside a non-escaped field; "if fields ` +
                `are not enclosed with double quotes, then double quotes may not appear ` +
                `inside the fields"`,
            );
          }
          value += text[i++];
        }
        record.push(value);
      }

      if (text[i] === ',') {
        i++;
        continue;
      }
      break;
    }

    records.push(record);

    if (i >= text.length) break;

    // *(CRLF record) -- the ONLY record separator the grammar admits is CRLF.
    if (text[i] === '\r' && text[i + 1] === '\n') {
      i += 2;
    } else if (text[i] === '\n') {
      violations.push(
        `[RFC 4180 s2.1] record separator at offset ${i} is a bare LF; "each record is ` +
          `located on a separate line, delimited by a line break (CRLF)"`,
      );
      i += 1;
    } else if (text[i] === '\r') {
      violations.push(
        `[RFC 4180 s2.1] record separator at offset ${i} is a bare CR, not CRLF`,
      );
      i += 1;
    }

    // [CRLF] -- a single trailing terminator ends the file (s2.2: "the last
    // record in the file may or may not have an ending line break").
    if (i >= text.length) break;
  }

  // [RFC 4180 s2.4] "Each line should contain the same number of fields
  // throughout the file."
  const widths = new Set(records.map((r) => r.length));
  if (widths.size > 1) {
    violations.push(
      `[RFC 4180 s2.4] ragged document: field counts ${[...widths].sort((a, b) => a - b).join('/')} ` +
        `appear in the same file`,
    );
  }

  return { records, violations };
}

// ---------------------------------------------------------------------------
// Proof the scanner can fail. A green check never shown to go red is worth
// nothing, so each RFC rule the scanner claims to enforce is exercised here
// against a document that breaks exactly that rule and nothing else.
// ---------------------------------------------------------------------------

describe('scanRfc4180 rejects non-conformant CSV (mutation proof)', () => {
  it.each([
    [
      'bare LF instead of CRLF between records',
      'a,b\nc,d',
      's2.1',
    ],
    [
      'bare CR instead of CRLF between records',
      'a,b\rc,d',
      's2.1',
    ],
    [
      'an unescaped DQUOTE inside a non-escaped field',
      'a,he said "hi"\r\nc,d',
      's2.5',
    ],
    [
      'an escaped field that is never closed',
      'a,"unterminated\r\nc,d',
      's2.7',
    ],
    [
      'junk after the closing DQUOTE of an escaped field',
      'a,"quoted"junk\r\nc,d',
      's2.5',
    ],
    [
      'a ragged record (a raw comma leaked into a cell)',
      'a,b\r\nc,d,e',
      's2.4',
    ],
  ])('flags %s', (_label, broken, section) => {
    const { violations } = scanRfc4180(broken);
    expect(violations.join('\n')).toContain(section);
  });

  it('accepts a document that obeys every rule it checks', () => {
    const clean = 'name,note\r\n"Wall, A","he said ""hi"""\r\n"multi\r\nline",plain';
    const { records, violations } = scanRfc4180(clean);
    expect(violations).toEqual([]);
    expect(records).toEqual([
      ['name', 'note'],
      ['Wall, A', 'he said "hi"'],
      ['multi\r\nline', 'plain'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The fixture. Deliberately asymmetric: every cell holds a DIFFERENT value, the
// row count differs from the column count, empty cells appear in the middle
// rather than only at the edge, and each hostile case sits at a different
// (row, column) so a writer bug tied to "first column" or "last row" cannot
// hide behind a symmetric fixture.
// ---------------------------------------------------------------------------

const COLUMNS: ColumnDefinition[] = [
  { id: 'name', source: 'attribute', propertyName: 'Name' },
  { id: 'note', source: 'attribute', propertyName: 'Description', label: 'Note, with comma' },
  { id: 'code', source: 'property', psetName: 'Pset_X', propertyName: 'Code' },
  { id: 'qty', source: 'quantity', psetName: 'Qto_X', propertyName: 'NetVolume' },
];

/**
 * Every cell distinct. Reading down a column and across a row both give four
 * different strings, so a transposition or an off-by-one in the writer shows up
 * as a mismatched VALUE rather than as a coincidentally-equal pass.
 */
const ROWS: CellValue[][] = [
  ['Wall, Type A', 'he said "hi"', '007', 12.5],
  ['line1\r\nline2', '', 'Grosse 3 m²', -0.35],
  ['line1\nline2', 'tab\there', 'semi;colon', null],
  ['plain', 'trailing space ', ' leading space', 0],
  // Fifth row so the grid is 5x4, not square: a transposition bug in the
  // writer would still produce a well-formed document from a square fixture.
  ['=SUM(A1:A2)', '\u00A0@cmd', 'a\u2028b', 1e21],
];

function result(rows: CellValue[][] = ROWS): ListResult {
  return {
    columns: COLUMNS,
    rows: rows.map((values, n) => ({ entityId: n + 1, modelId: 'default', values })),
    totalCount: rows.length,
    executionTime: 0,
  };
}

// ---------------------------------------------------------------------------
// Real output, checked against the RFC and against a stranger's parser.
// ---------------------------------------------------------------------------

describe('listResultToCSV is RFC 4180 conformant', () => {
  it('emits a document the RFC 4180 grammar accepts', () => {
    const { violations } = scanRfc4180(listResultToCSV(result()));
    expect(violations).toEqual([]);
  });

  it('agrees with an independent parser about records and fields', () => {
    // If our transcription of the ABNF and csv-parse disagree, the scanner
    // above is not trustworthy and neither is anything else in this file.
    const csv = listResultToCSV(result());
    const mine = scanRfc4180(csv).records;
    const theirs = parse(csv, { bom: false, relaxColumnCount: false }) as string[][];
    expect(mine).toEqual(theirs);
  });

  it('keeps every record the same width [RFC 4180 s2.4]', () => {
    const csv = listResultToCSV(result());
    const records = parse(csv, { relaxColumnCount: false }) as string[][];
    expect(records).toHaveLength(ROWS.length + 1); // header + rows
    for (const r of records) expect(r).toHaveLength(COLUMNS.length);
  });
});

// ---------------------------------------------------------------------------
// Round trip through a stranger's parser: does every cell survive?
//
// The expected column is written out by hand, NOT computed from the writer, so
// it cannot silently agree with a writer change. Where the expectation differs
// from the input that is a DELIBERATE, documented transform (the CWE-1236
// formula guard adds a leading apostrophe); every other cell must come back
// byte-identical.
// ---------------------------------------------------------------------------

describe('every cell survives a third-party parser round trip', () => {
  it.each<[string, CellValue, string]>([
    ['embedded delimiter', 'Wall, Type A', 'Wall, Type A'],
    ['embedded double quote', 'he said "hi"', 'he said "hi"'],
    ['field that is only a quote', '"', '"'],
    ['field that is only a delimiter', ',', ','],
    ['embedded CRLF', 'line1\r\nline2', 'line1\r\nline2'],
    ['embedded bare LF', 'line1\nline2', 'line1\nline2'],
    ['embedded bare CR', 'line1\rline2', 'line1\rline2'],
    ['embedded TAB', 'tab\there', 'tab\there'],
    ['empty', '', ''],
    ['leading zero', '007', '007'],
    ['leading space is data [RFC 4180 s2.4]', ' leading', ' leading'],
    ['trailing space is data [RFC 4180 s2.4]', 'trailing ', 'trailing '],
    ['non-ASCII', 'Größe 3 m²', 'Größe 3 m²'],
    ['U+2028 line separator', 'a\u2028b', 'a\u2028b'],
    ['astral plane', '\u{1d11e}', '\u{1d11e}'],
    // NOT a writer defect, and worth pinning so nobody "fixes" it: a lone
    // surrogate has no UTF-8 encoding, so the moment the string becomes bytes
    // -- here by csv-parse, identically by `fs.writeFile(..., 'utf8')` -- it
    // becomes U+FFFD. Our escaper passes it through untouched; the loss is the
    // encoding's, and no CSV writer can avoid it.
    ['lone high surrogate degrades to U+FFFD (UTF-8, not us)', '\ud800', '\uFFFD'],
    ['number', 12.5, '12.5'],
    ['negative number stays summable', -0.35, '-0.35'],
    ['null becomes empty', null, ''],
    // Deliberate, documented transform: the CWE-1236 guard prefixes an
    // apostrophe so a spreadsheet renders the cell as text.
    ['formula is neutralised, not lost', '=SUM(A1:A2)', "'=SUM(A1:A2)"],
    ['formula with a delimiter inside', '@SUM(1,2)', "'@SUM(1,2)"],
  ])('%s', (_label, input, expected) => {
    const csv = listResultToCSV(result([[input, 'other', 'cells', 'differ']]));
    const records = parse(csv, { relaxColumnCount: false }) as string[][];
    expect(records[1][0]).toBe(expected);
    // The neighbouring cells must not have been disturbed by the hostile one.
    expect(records[1].slice(1)).toEqual(['other', 'cells', 'differ']);
  });

  it('preserves a hostile cell in every column position', () => {
    // Position-independence: a fixture that only ever puts the nasty value in
    // column 0 cannot see a bug in the last-field path (no trailing delimiter)
    // or in the header path.
    const hostile = 'a,b"c\r\nd';
    for (let col = 0; col < COLUMNS.length; col++) {
      const values: CellValue[] = ['p', 'q', 'r', 's'];
      values[col] = hostile;
      const records = parse(listResultToCSV(result([values])), {
        relaxColumnCount: false,
      }) as string[][];
      expect(records[1][col]).toBe(hostile);
    }
  });

  it('preserves a hostile COLUMN LABEL, not just a cell [RFC 4180 s2.3]', () => {
    // The header row goes through the same escaper; a fixture with only plain
    // labels never observes that.
    const records = parse(
      listResultToCSV({
        columns: [
          { id: 'a', source: 'attribute', propertyName: 'A', label: 'Label, with comma' },
          { id: 'b', source: 'attribute', propertyName: 'B', label: 'Label "quoted"' },
          { id: 'c', source: 'attribute', propertyName: 'C', label: 'Label\r\nwrapped' },
        ],
        rows: [],
        totalCount: 0,
        executionTime: 0,
      }),
      { relaxColumnCount: false },
    ) as string[][];
    expect(records[0]).toEqual(['Label, with comma', 'Label "quoted"', 'Label\r\nwrapped']);
  });
});

// ---------------------------------------------------------------------------
// CWE-1236 spreadsheet formula injection, judged on what a THIRD-PARTY parser
// recovers rather than on the bytes we wrote.
//
// This is not an RFC 4180 rule -- the RFC has nothing to say about what a
// spreadsheet does with a conformant field. It is checked here because the
// round trip is the only place the guard's real contract is observable: after
// parsing, no cell may still start with a trigger character, INCLUDING when the
// trigger hides behind leading invisible characters. `\uFEFF=HYPERLINK(...)`
// is not a formula to the pre-hardening guard, which anchored the trigger
// characters at offset 0, but it is one to Excel.
// ---------------------------------------------------------------------------

const TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/** Leading characters a spreadsheet ignores when deciding "is this a formula". */
const INVISIBLE_PREFIXES = [
  '\uFEFF', // BOM (Cf)
  '\u200B', // ZERO WIDTH SPACE (Cf)
  '\u200E', // LEFT-TO-RIGHT MARK (Cf)
  '\u00A0', // NO-BREAK SPACE (Zs)
  '\u2028', // LINE SEPARATOR (Zl)
  '\u2029', // PARAGRAPH SEPARATOR (Zp)
  ' ', // plain space (Zs)
];

function looksLikeFormula(cell: string): boolean {
  const past = cell.replace(/^[\p{Cf}\p{Z}]+/u, '');
  return TRIGGERS.some((t) => past.startsWith(t));
}

describe('formula injection cannot survive the round trip', () => {
  it('looksLikeFormula itself can fail (mutation proof)', () => {
    // The detector is the thing under test in this block, so prove it is not
    // vacuously false for every input.
    expect(looksLikeFormula('=SUM(A1)')).toBe(true);
    expect(looksLikeFormula('\uFEFF=HYPERLINK("http://x","y")')).toBe(true);
    expect(looksLikeFormula('\u00A0@cmd')).toBe(true);
    expect(looksLikeFormula("'=SUM(A1)")).toBe(false);
    expect(looksLikeFormula('Wall')).toBe(false);
  });

  it.each(
    INVISIBLE_PREFIXES.flatMap((prefix) =>
      ['=HYPERLINK("http://evil","x")', '@cmd', '+cmd'].map(
        (payload) => [JSON.stringify(prefix + payload), prefix + payload] as const,
      ),
    ),
  )('neutralises %s', (_label, payload) => {
    const csv = listResultToCSV(result([[payload, 'b', 'c', 'd']]));
    const records = parse(csv, { relaxColumnCount: false }) as string[][];
    expect(looksLikeFormula(records[1][0])).toBe(false);
  });

  it('neutralises a hidden formula in a COLUMN LABEL too', () => {
    const csv = listResultToCSV({
      columns: [{ id: 'a', source: 'attribute', propertyName: 'A', label: '\uFEFF=cmd|calc' }],
      rows: [],
      totalCount: 0,
      executionTime: 0,
    });
    const records = parse(csv, { relaxColumnCount: false }) as string[][];
    expect(looksLikeFormula(records[0][0])).toBe(false);
  });

  it('leaves a plain signed number summable (deliberate exemption)', () => {
    // Pinned by engine.test.ts and by issue #1772: quoting `-0.35` broke
    // Excel SUM(). Guarding invisibles must not regress that.
    const csv = listResultToCSV(result([[-0.35, '+41', '-1e5', '1.5']]));
    const records = parse(csv, { relaxColumnCount: false }) as string[][];
    expect(records[1]).toEqual(['-0.35', '+41', '-1e5', '1.5']);
  });
});

// ---------------------------------------------------------------------------
// Non-comma delimiters. Outside RFC 4180 (which defines COMMA = %x2C only), so
// this block makes no RFC claim -- it only asks whether an independent parser
// configured for the same delimiter gets our cells back.
// ---------------------------------------------------------------------------

describe('a non-comma delimiter still round trips (not an RFC 4180 claim)', () => {
  it.each([';', '\t', '|'])('delimiter %j', (delimiter) => {
    const rows: CellValue[][] = [
      [`has${delimiter}delim`, 'has,comma', 'has"quote', 'plain'],
      ['line1\r\nline2', '', '007', 42],
    ];
    const csv = listResultToCSV(result(rows), delimiter);
    const records = parse(csv, { delimiter, relaxColumnCount: false }) as string[][];
    expect(records[1]).toEqual([`has${delimiter}delim`, 'has,comma', 'has"quote', 'plain']);
    expect(records[2]).toEqual(['line1\r\nline2', '', '007', '42']);
  });
});
