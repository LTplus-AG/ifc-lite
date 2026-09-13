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

/**
 * A record whose parens balance only PAST a later declaration must not hand
 * back a resume point past that declaration (#4573). Pre-fix the balance walk
 * closed #1 at #2's ')' and the fast scan resumed after it, so #2 vanished
 * with nothing reported. The walk now stops at #2's '=', #1 is dropped alone,
 * and #2 (its own ')' then ';') is found by the re-hunt. Matches Rust's
 * `recovery_does_not_resume_past_the_next_declaration_4179`.
 */
export const NEXT_DECLARATION_CASE = {
  text: '#1=IFCA(2 #2=IFCWALL($));\n#3=IFCC(3);\n',
  spans: [[2, '#2=IFCWALL($));'], [3, '#3=IFCC(3);']] as const,
};

/**
 * A refused record must not damage its NEIGHBOUR. #1 is refused at the stray
 * '=' in its body and re-hunted from past its '#'; the hunt then meets
 * `#5 = 3);`, which has a declaration's `#<digits> =` prefix. It is refused
 * at the type-name check (a record needs a keyword after the '='), so the
 * real #5 declared a line earlier is the only #5. Matches Rust's
 * `a_stray_equals_in_a_refused_body_does_not_mint_a_phantom_neighbour`.
 */
export const PHANTOM_NEIGHBOUR_CASE = {
  text: '#5=IFCCARTESIANPOINT((0.,0.));\n#1=IFCWALL(#5 = 3);\n#6=IFCWALL($);\n',
  ids: [5, 6] as const,
};

/**
 * Files that are nothing but refused records, one per way of reaching the
 * balance walk (#4573). `#1=A(2;` finds a ';' with no ')' before it, so the
 * exact check balances the record; `#1=A(` never finds a ';' at all, so the
 * recovery balances it. The trailers are what disarmed a suffix-memo cut of
 * the fix: a lone ';', and the `ENDSEC;` every real file ends with.
 *
 * Pre-fix each walk read to end of input and the next declaration repeated
 * it: measured 1.8-2.5s at 10 000 records and 7.4-10s at 20 000, 4x per
 * doubling, on the fast scan and the worker copy alike. Bounded at the next
 * '=', all four cost the file's length. `RECORDS` is sized so the unfixed
 * walk overruns the budget many times over on any machine (the well-formed
 * twin takes ~2ms here; the 20ms floor keeps timer noise out), while a fixed
 * scan finishes in single-digit milliseconds.
 */
export const QUADRATIC_SHAPES: readonly (readonly [string, string, string])[] = [
  ['#1=A(2;\\n', '#1=A(2;\n', ''],
  ['#1=A(\\n', '#1=A(\n', ''],
  ['#1=A(\\n then ;', '#1=A(\n', ';'],
  ['#1=A(\\n then ENDSEC', '#1=A(\n', 'ENDSEC;\nEND-ISO-10303-21;\n'],
];
export const QUADRATIC_RECORDS = 20_000;
export const QUADRATIC_WELL_FORMED = '#1=A();\n';
/** The budget a refused-record file must scan within, from the well-formed twin's time. */
export function quadraticBudgetMs(baselineMs: number): number {
  return Math.max(baselineMs, 20) * 20;
}

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
