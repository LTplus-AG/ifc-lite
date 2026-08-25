/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regenerates `rust/export/tests/fixtures/csv_cell_vectors.json` — the ONE
 * table of cases the TypeScript and Rust CSV-cell escapers are both pinned to.
 *
 * Only the `invisiblePrefixRanges` block is machine-derived (from this Node
 * build's `\p{Cf}\p{Z}` tables); the cases are authored by hand below. Run
 * with `node scripts/gen-csv-cell-vectors.mjs` after a deliberate Unicode
 * bump — never to make a failing parity test pass, since a change in those
 * ranges IS the drift the parity sweep exists to surface.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INVISIBLE = /[\p{Cf}\p{Z}]/u;
const PADDING = /\s/u;

function deriveRanges(re) {
  const ranges = [];
  let start = null;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    // Lone surrogates are category Cs; skipping them keeps `fromCodePoint`
    // honest and cannot open a gap (Cs is in neither Cf nor Z, nor \s).
    if (cp >= 0xd800 && cp <= 0xdfff) {
      if (start !== null) { ranges.push([start, cp - 1]); start = null; }
      continue;
    }
    if (re.test(String.fromCodePoint(cp))) {
      if (start === null) start = cp;
    } else if (start !== null) {
      ranges.push([start, cp - 1]);
      start = null;
    }
  }
  if (start !== null) ranges.push([start, 0x10ffff]);
  return ranges;
}

const BOM = '﻿';
const ZWSP = '​';
const LRM = '‎';
const NBSP = ' ';
const LSEP = ' ';
const PSEP = ' ';

const cases = [
  { name: 'empty stays empty', input: '', expected: '' },
  { name: 'plain text is untouched', input: 'Wall A', expected: 'Wall A' },
  { name: 'delimiter forces quoting', input: 'a,b', expected: '"a,b"' },
  { name: 'interior quote is doubled and wrapped', input: 'a"b', expected: '"a""b"' },
  { name: 'embedded LF forces quoting', input: 'a\nb', expected: '"a\nb"' },
  { name: 'embedded CR forces quoting', input: 'a\rb', expected: '"a\rb"' },
  {
    name: 'a comma is NOT quoted when the delimiter is a semicolon',
    input: 'a,b', expected: 'a,b', delimiter: ';',
  },
  { name: 'semicolon delimiter forces quoting', input: 'a;b', expected: '"a;b"', delimiter: ';' },

  { name: 'equals is a formula trigger', input: '=1+1', expected: "'=1+1" },
  {
      name: 'plus is a formula trigger when the exemption is opted out of',
      input: '+1', expected: "'+1", exemptNumbers: false,
    },
  {
      name: 'minus is a formula trigger when the exemption is opted out of',
      input: '-0.35', expected: "'-0.35", exemptNumbers: false,
    },
  { name: 'at is a formula trigger', input: '@SUM(A1)', expected: "'@SUM(A1)" },
  { name: 'leading TAB is a formula trigger', input: '\tcmd', expected: "'\tcmd" },
  {
    name: 'leading CR is a formula trigger and forces quoting',
    input: '\rcmd', expected: '"\'\rcmd"',
  },

  {
    name: 'BOM cannot hide a trigger',
    input: `${BOM}=cmd|'/c calc'!A1`, expected: `'${BOM}=cmd|'/c calc'!A1`,
  },
  { name: 'zero-width space cannot hide a trigger', input: `${ZWSP}=cmd`, expected: `'${ZWSP}=cmd` },
  { name: 'left-to-right mark cannot hide a trigger', input: `${LRM}=cmd`, expected: `'${LRM}=cmd` },
  { name: 'non-breaking space cannot hide a trigger', input: `${NBSP}=cmd`, expected: `'${NBSP}=cmd` },
  {
    name: 'LINE SEPARATOR (Zl, outside Zs) cannot hide a trigger',
    input: `${LSEP}=cmd`, expected: `'${LSEP}=cmd`,
  },
  {
    name: 'PARAGRAPH SEPARATOR (Zp, outside Zs) cannot hide a trigger',
    input: `${PSEP}=cmd`, expected: `'${PSEP}=cmd`,
  },
  { name: 'ordinary spaces cannot hide a trigger', input: '   =cmd', expected: "'   =cmd" },
  {
    name: 'a run of mixed invisibles cannot hide a trigger',
    input: `${BOM}${NBSP}${ZWSP}${LSEP} =HYPERLINK("http://x")`,
    expected: `"'${BOM}${NBSP}${ZWSP}${LSEP} =HYPERLINK(""http://x"")"`,
  },

  {
    name: 'RFC 4180 2.4: leading whitespace on a benign value is preserved',
    input: '   Wall A', expected: '   Wall A',
  },
  {
    name: 'RFC 4180 2.4: trailing whitespace on a benign value is preserved',
    input: 'Wall A   ', expected: 'Wall A   ',
  },
  {
    name: 'RFC 4180 2.4: a benign value led by a BOM keeps the BOM',
    input: `${BOM}Wall A`, expected: `${BOM}Wall A`,
  },
  {
    name: 'an invisible run with no trigger behind it is left alone',
    input: `${ZWSP}${ZWSP}Wall`, expected: `${ZWSP}${ZWSP}Wall`,
  },
  { name: 'a cell of nothing but invisibles is left alone', input: `${BOM}${NBSP}`, expected: `${BOM}${NBSP}` },

  {
      name: 'numeric exemption opted out: a negative measure is guarded',
      input: '-0.35', expected: "'-0.35", exemptNumbers: false,
    },
  {
    name: 'numeric exemption on: a negative measure stays summable',
    input: '-0.35', expected: '-0.35', exemptNumbers: true,
  },
  {
    name: 'numeric exemption on: a signed integer stays summable',
    input: '+1', expected: '+1', exemptNumbers: true,
  },
  {
    name: 'numeric exemption on: exponent notation stays summable',
    input: '-1.5e-3', expected: '-1.5e-3', exemptNumbers: true,
  },
  {
    name: 'numeric exemption on: a real trigger is still guarded',
    input: '=1+1', expected: "'=1+1", exemptNumbers: true,
  },
  {
    name: 'numeric exemption on: a number behind an invisible is still guarded',
    input: `${ZWSP}-0.35`, expected: `'${ZWSP}-0.35`, exemptNumbers: true,
  },
  {
    name: 'numeric exemption on: a number with a payload glued on is still guarded',
    input: '-0.35=cmd', expected: "'-0.35=cmd", exemptNumbers: true,
  },
  {
    name: 'numeric exemption on: a lone sign is not a number and stays guarded',
    input: '-', expected: "'-", exemptNumbers: true,
  },
  {
    name: 'numeric exemption never applies to =, @ or TAB',
    input: '@1', expected: "'@1", exemptNumbers: true,
  },

  // `quoteWhitespacePadded` — the zones-table writer's extra rule. Quoting a
  // padded cell is how the padding survives an importer that would otherwise
  // trim it, i.e. the same RFC 4180 §2.4 concern the non-destructive guard has.
  {
    name: 'padded quoting off (default): a leading-space cell is left bare',
    input: ' Wall A', expected: ' Wall A',
  },
  {
    name: 'padded quoting on: a leading-space cell is wrapped',
    input: ' Wall A', expected: '" Wall A"', quoteWhitespacePadded: true,
  },
  {
    name: 'padded quoting on: a trailing-space cell is wrapped',
    input: 'Wall A ', expected: '"Wall A "', quoteWhitespacePadded: true,
  },
  {
    name: 'padded quoting on: an unpadded cell is still left bare',
    input: 'Wall A', expected: 'Wall A', quoteWhitespacePadded: true,
  },
  {
    name: 'padded quoting on: a trailing BOM counts as padding (JS \\s includes U+FEFF)',
    input: `Wall${BOM}`, expected: `"Wall${BOM}"`, quoteWhitespacePadded: true,
  },
  {
    name: 'padded quoting on: NEL U+0085 is NOT padding (JS \\s excludes it, Rust White_Space includes it)',
    input: 'Wall\u0085', expected: 'Wall\u0085', quoteWhitespacePadded: true,
  },
  {
    name: 'padded quoting on: the apostrophe lands in front, so a guarded cell is no longer front-padded',
    input: ' =cmd', expected: "' =cmd", quoteWhitespacePadded: true,
  },
  {
    name: 'padded quoting on: a guarded cell with trailing padding is still wrapped',
    input: ' =cmd ', expected: '"\' =cmd "', quoteWhitespacePadded: true,
  },
    // The numeric language's boundaries. Each accepted case is a shape a naive
    // rewrite of the scan drops; each rejected case is a way it could wrongly
    // accept. `-1,000` and `-3.000` are what a DISPLAY formatter emits for
    // -1000 and -3000 under en-US and de-DE, which is why they are here.
    {
      name: 'numeric exemption on: a bare decimal point with no integer part',
      input: '-.5', expected: '-.5', exemptNumbers: true,
    },
    {
      name: 'numeric exemption on: a trailing decimal point with no fraction',
      input: '-1.', expected: '-1.', exemptNumbers: true,
    },
    { name: 'numeric exemption on: an uppercase exponent', input: '-1E5', expected: '-1E5', exemptNumbers: true },
    {
      name: 'numeric exemption on: a dot-grouped integer, which de-DE displayCell emits for -3000',
      input: '-3.000', expected: '-3.000', exemptNumbers: true,
    },
    {
      name: 'numeric exemption on: a sign and a lone decimal point carry no digit',
      input: '-.', expected: "'-.", exemptNumbers: true,
    },
    {
      name: 'numeric exemption on: an exponent marker with no exponent digits',
      input: '-1e', expected: "'-1e", exemptNumbers: true,
    },
    {
      name: 'numeric exemption on: an exponent sign with no exponent digits',
      input: '-1e+', expected: "'-1e+", exemptNumbers: true,
    },
    {
      name: 'numeric exemption on: a comma-grouped integer, which en-US displayCell emits for -1000',
      input: '-1,000', expected: `"'-1,000"`, exemptNumbers: true,
    },
    {
      name: 'numeric exemption on: a trailing newline is past the end of the number',
      input: '-1\n', expected: `"'-1\n"`, exemptNumbers: true,
    },
    {
      name: 'numeric exemption on: full-width digits are not ASCII digits',
      input: '-\uFF11', expected: "'-\uFF11", exemptNumbers: true,
    },
    {
      name: 'numeric exemption on: Arabic-Indic digits are not ASCII digits',
      input: '-\u0661', expected: "'-\u0661", exemptNumbers: true,
    },
    {
      name: 'numeric exemption on: a space-grouped integer is not one number',
      input: '-1 000', expected: "'-1 000", exemptNumbers: true,
    },

    // Vectors that set NO options at all, so they pin the two languages'
    // DEFAULTS against each other. Without these, both harnesses spell every
    // option out and a default drifting on one side is invisible.
    { name: 'DEFAULT OPTIONS: a negative measure is exempt', input: '-0.35', expected: '-0.35' },
    { name: 'DEFAULT OPTIONS: a signed integer is exempt', input: '+1', expected: '+1' },
    { name: 'DEFAULT OPTIONS: a real formula trigger is still guarded', input: '=1+1', expected: "'=1+1" },
    {
      name: 'DEFAULT OPTIONS: a number with a payload glued on is still guarded',
      input: '-0.35=cmd', expected: "'-0.35=cmd",
    },
];
const doc = {
  '//': [
    'Shared cross-language CSV-cell vectors. The TypeScript escaper',
    '(packages/export/src/csv-cell.ts, via csv-cell.parity.test.ts) and the Rust',
    'escaper (rust/export/src/csv_cell.rs, via tests/csv_cell_parity.rs) are BOTH',
    'pinned to this file, so the two cannot drift unnoticed.',
    'Regenerate the ranges with scripts/gen-csv-cell-vectors.mjs; author cases by hand.',
    'A case that omits an option gets the LIBRARY default for it, not a value spelled out by the harness -- that is what the DEFAULT OPTIONS cases pin.',
  ].join(' '),
  invisiblePrefixNote: [
    'Code points a spreadsheet importer swallows or renders as spacing, yet which do',
    'NOT stop a following =/+/-/@ from being evaluated as a formula. Exactly Unicode',
    'general categories Cf + Z (Zs, Zl, Zp). TypeScript spells this /[\\p{Cf}\\p{Z}]/u;',
    'Rust spells it as a const range table. Both suites sweep every code point',
    '0..=0x10FFFF against the ranges below, so an engine/table mismatch fails loudly',
    'instead of silently re-opening the bypass.',
  ].join(' '),
  invisiblePrefixRanges: deriveRanges(INVISIBLE),
  paddingNote: [
    'Code points that count as whitespace PADDING for the opt-in',
    '`quoteWhitespacePadded` rule (a padded cell is quoted so an importer cannot',
    'trim the padding away). Defined as JavaScript `\\s`, which is NOT the same',
    'set as Rust `char::is_whitespace` (Unicode White_Space): JS includes U+FEFF',
    'and excludes U+0085 NEL, White_Space is the other way round. Spelling it as',
    'one table is what stops that asymmetry becoming a silent behaviour split.',
  ].join(' '),
  paddingRanges: deriveRanges(PADDING),
  cases,
};

const out = fileURLToPath(
  new URL('../rust/export/tests/fixtures/csv_cell_vectors.json', import.meta.url),
);
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
process.stdout.write(`wrote ${out}: ${cases.length} cases, ${doc.invisiblePrefixRanges.length} ranges\n`);
