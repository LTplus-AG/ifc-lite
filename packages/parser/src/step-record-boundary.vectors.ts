/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared #4179 record-boundary cases for the two TypeScript scan copies.
 *
 * The SCANNERS are hand-duplicated because a Blob worker cannot import at
 * runtime. A test file is an ordinary module and has no such excuse, so the
 * vectors live here once and `tokenizer.test.ts` and
 * `scan-worker-source.malformed-record.test.ts` supply only their own driver.
 * They were copies for one commit and had already drifted inside it.
 */

/** What a scan returned: each record as `[expressId, source text]`. */
export type ScanSpans = { spans: (readonly [number, string])[]; malformed: number };

/** Drives one scan implementation over `text`. */
export type ScanDriver = (text: string) => ScanSpans;

/**
 * Records that must be ACCEPTED, i.e. the false-positive direction.
 *
 * Every shape is hand-constructed because a 487-file, 14,282,864-record sweep
 * of this repo's IFC corpus contains NONE of them: zero records with a comment
 * between the ')' and the ';', and zero with any whitespace there either. A
 * clean sweep over a population without the case is not evidence about the
 * case. What the corpus DOES carry, and so does attest: 6,816,392 records
 * ending in a nested '))', 234,391 spanning several lines, and 15,111 with an
 * '=' inside a string or comment, all accepted.
 */
export const LEGAL_BODIES: readonly string[] = [
  "IFCWALL('a=b',$);",
  'IFCWALL($ /* a=b */);',
  "IFCDOCUMENTREFERENCE('http://h/q?a=b&c=d',$);",
  'IFCWALL($)/* trailing */;',
  'IFCWALL($)/* one *//* two */;',
  'IFCWALL($) /* spaced */ \t /* twice */ ;',
  'IFCWALL($)/* multi\nline */;',
  "IFCWALL(('a'),(1.,2.));",
  "IFCWALL(\n  'a',\n  $\n);",
  // isSpaceByte includes vertical tab and form feed; a form feed silently
  // dropping an entity is exactly what #3733 was.
  ...[' ', '\t', '\r', '\n', '\v', '\f'].flatMap((sp) => [
    `IFCWALL($)${sp};`,
    `IFCWALL($)${sp}/* c */${sp};`,
  ]),
];

/**
 * A record with no closing ')' at all costs ONE record, not the tail.
 *
 * `close_step_record`'s two failures are not interchangeable: this one leaves
 * every literal and comment closed, so the bytes after are readable and the
 * scan re-hunts from past the record's '#'. Collapsing it with the
 * unreadable case below took `[1]` from an input the parent scanner read as
 * `[1, 2, 3, 4]`, which is the amplification #4179 exists to remove.
 */
export const UNBALANCED_CASE = {
  text: '#1=IFCA(1);\n#2=IFCB(2;\n#3=IFCC(3);\n#4=IFCD(4);\n',
  spans: [[1, '#1=IFCA(1);'], [3, '#3=IFCC(3);'], [4, '#4=IFCD(4);']] as const,
};

/** Bodies with no ';' of their own AND no balancing ')' to resume at. */
export const UNRESUMABLE_BODIES: readonly string[] = [
  "IFCWALL('never closes,$)",
  'IFCWALL(/* never closes $)',
];

/** The two shapes #4179 is about, as `[label, text, expected spans]`. */
/**
 * Records whose LINE numbers a cold re-walk must not disturb.
 *
 * The worker's comment skip advances its line counter as a side effect, so a
 * caller that balances the record again to settle the ')' rule inflates every
 * later line unless it saves and restores. `#2` here landed on line 4 in the
 * worker and line 3 in the tokenizer for the same bytes.
 */
export const LINE_NUMBER_CASE = {
  text: '#1=IFCWALL(/* a\nb */$)/* c */;\n#2=IFCDOOR($);\n',
  lines: [1, 3] as const,
};

export const SWALLOW_CASES: readonly (readonly [string, string, (readonly [number, string])[]])[] = [
  [
    // Pre-fix: [#1, #2, #4] -- #3 gone, #2's span covering #3's whole record,
    // and no diagnostic. The broken record is DROPPED, not the tail: #3 and #4
    // both survive, because the scan resumes at the ')' balancing #2's own '('.
    'a record missing its own ";" does not swallow the next record',
    '#1=IFCA(1);\n#2=IFCB(2)\n#3=IFCC(3);\n#4=IFCD(4);\n',
    [[1, '#1=IFCA(1);'], [3, '#3=IFCC(3);'], [4, '#4=IFCD(4);']],
  ],
  [
    // Pre-fix: #2's span absorbed "ENDSEC;" and nothing was reported, so the
    // file read as fully successful having lost a structural marker.
    'a truncated last record does not swallow the footer',
    "#1=IFCPROJECT('a');\n#2=IFCWALL('b')\nENDSEC;\nEND-ISO-10303-21;\n",
    [[1, "#1=IFCPROJECT('a');"]],
  ],
];
