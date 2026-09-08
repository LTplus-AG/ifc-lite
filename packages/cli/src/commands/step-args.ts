/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reading a STEP record's top-level argument list out of its text, for a
 * caller that then edits one slot BY INDEX.
 *
 * The failure this exists to prevent is silent. A scanner that loses track of
 * quote state or paren depth still produces parts; they are just not the
 * record's arguments any more, because the commas it swallowed took every
 * following slot with them. The write lands on whatever the mis-scan
 * accumulated and the caller reports a success that did not happen
 * (LTplus-AG/ifc-lite#2470, #4125 for the `mutate` instance). So this returns
 * null rather than parts it does not believe in.
 *
 * The mis-scan nothing structural notices is an undoubled apostrophe, what an
 * authoring tool emits when it forgets to double one. The scan closes the
 * string at it and reopens on the next quote, so the text between the two is
 * read inside-out and every comma in it is swallowed. TWO of them leave quote
 * parity EVEN and paren depth at ZERO, so the scan ends clean on text that
 * split wrong: `'guid',$,'John's wall',$,$,$,$,'A's',.NOTDEFINED.` is nine
 * attributes read as four, and writing slot 2 deletes attributes 3 to 7.
 *
 * What always shows is a token ending where a token cannot end: the phantom
 * terminator leaves the rest of the content where a separator belongs
 * (`'John's wall'` closes after `John`, leaving a bare `s`). So this validates
 * the list as a grammar rather than counting characters. An argument is ONE
 * token, after a token only whitespace and then `,` or `)` may follow, and that
 * (In the STEP examples below, `*\/` is a JavaScript escape so the example does not
 * terminate this comment block. The backslash is not in the STEP text, and STEP
 * gives `\` its own meaning, so strip it before copying an example into a test.)
 *
 * holds AT EVERY DEPTH. Applied to the top level alone it misses a phantom that
 * swallows a `)`, a `(` and the comma between them, which leaves the depth
 * balanced and each surviving part passing a token check on its own:
 * `IFCLABEL('a's'),$,IFCLABEL('b's'),$` is four attributes read as two. Any
 * two top-level slots that each hold a string inside parens can do it, and real
 * entities have that shape (`IfcPerson`'s MiddleNames / PrefixTitles,
 * `IfcPropertyTableValue`'s DefiningValues / DefinedValues).
 *
 * What the rule cannot see is a corruption whose bytes are themselves a valid
 * argument list: a stray apostrophe at the END of a string's content emits a
 * doubled quote by accident, so `''','''` is two arguments to its author and
 * one to anyone reading the text. A generated sweep accepted 814 of 80,035 corruptions
 * with a split other than the author's, down from 1,066 before the rule reached into
 * lists, and every survivor it looked at had that shape; separating them needs the
 * schema, not the text. That harness is NOT committed, so those figures record one run
 * and cannot be reproduced from this tree.
 *
 * A STEP block comment is refused rather than understood, because `mutate` must
 * not rewrite a record it cannot read: `/` breaks a bare run, so a part
 * carrying a comment outside a string is never one token, whatever the comment
 * CONTAINS. Whitespace in the comment is not what gives it away:
 * `$,/*renamed*\/,$` has none and was read as three slots for two attributes,
 * the same phantom-slot shift as the rest of #4125 (see {@link isTokenBreak}
 * for why breaking on the OPENER is enough).
 *
 * Several readers in this repo DO skip comments; diverging from them is
 * deliberate. The nearest is `validate.ts` in this very package, which skips
 * `/* ... *\/` while counting top-level attribute indices; it returns indices
 * rather than parts, so it never has to put the bytes back. `source-header.ts`'s
 * `splitTopLevel` is closer still, since it returns PARTS, but it drops the
 * comment bytes, so it cannot satisfy the round-trip contract below either.
 * And `packages/parser`'s
 * `entity-extractor.ts` reads comments at every depth through
 * `StepTextScan.skipLexicalAt`, and says so as policy: one comment-skip rule for
 * decoded STEP text rather than a fourth hand-rolled copy. The difference is what
 * the two produce. That one extracts VALUES and collapses a comment to a space;
 * this one must satisfy `parts.join(',') === input` byte for byte, because its
 * caller rewrites the user's file. Skipping a comment under that contract would
 * silently delete it from their file, and keeping it inside the part means the
 * part is not one token. Doing both needs a richer return type than `string[]`,
 * which is a different module. (`STEP_TRIVIA` itself is legal anywhere whitespace
 * is. Its call sites are what place it, and they all put it immediately before a
 * `\(`.)
 *
 * What this module does NOT cover, so its refusal is not read as more than it is:
 * `mutate` finds records with a line regex that allows only whitespace before the
 * `(`, so a comment after the class keyword is skipped BEFORE reaching this code,
 * and the run reports success having changed nothing; and `lastIndexOf(')')` can
 * slice into a legal trailing comment. Both are #4163, one on each SIDE of the
 * argument list (before the `(`, after the `)`), and both are the same
 * line-versus-record shape as the wrapped-record case #4163 also covers.
 *
 * `packages/export/src/step-argument-parser.ts` is the nearest copy, and this is
 * deliberately its near-twin rather than an import: `@ifc-lite/export`'s
 * `exports` map exposes only `.`, so reaching it would mean adding a published
 * export (and an `api-surface` entry) to a v4.0.0 package to fix a CLI bug.
 * #4125 tracks consolidating them (`derive-variants.mts` and
 * `placement-datum.test.ts` are two the issue does not name), and that is a real merge rather
 * than a no-op swap: its `splitTopLevelStepArguments` has the three structural
 * checks and NO per-part check at all, which is exactly the top-level-only
 * version the two paragraphs above show is insufficient. Measured, it splits
 * `$,/* renamed *\/ $` into two parts and `'guid',$,'Name',/* c *\/,$` into five.
 * The three structural checks are the contract the two DO share.
 */

/**
 * Split a STEP argument list on top-level commas, or return null when the text
 * cannot be scanned as one. `input` is the text BETWEEN a record's outermost
 * parentheses; the module header says why null rather than parts.
 *
 * Nothing is trimmed and nothing is normalised, so for input this accepts
 * `parts.join(',')` reproduces `input` byte for byte and a caller that replaces
 * one part leaves every other byte of the record alone. Rejected: a quote still
 * open at the end, a paren depth that does not return to zero, a depth that
 * ever goes NEGATIVE (a stray closing paren balanced by a later opening one),
 * and a part that is not one token at every depth (see {@link isLoneStepToken}).
 *
 * An EMPTY top-level slot (`a,,b`, or a trailing comma) is NOT rejected: it is
 * invalid STEP that costs no alignment, since an empty argument is one part
 * exactly as the entity parser counts it, so every index still names the
 * attribute it is meant to. An empty INPUT is not an empty slot: `#1=IFCFOO();`
 * has no arguments, so it splits to `[]` and any slot request then fails the
 * caller's bounds check.
 */
export function splitTopLevelStepArgs(input: string): string[] | null {
  if (input === '') return [];

  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === "'") {
      current += char;
      // A doubled quote INSIDE a string is an escaped apostrophe. Outside one
      // the first quote opens a string and the second is read on its own next
      // pass, so `''` there is the empty string rather than an escape.
      if (inString && input[i + 1] === "'") {
        current += input[i + 1];
        i++;
        continue;
      }
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '(') {
        depth++;
      } else if (char === ')') {
        depth--;
        if (depth < 0) return null;
      } else if (char === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
    }

    current += char;
  }

  if (inString || depth !== 0) return null;
  parts.push(current);
  // These three are the contract this shares with
  // `packages/export/src/step-argument-parser.ts`, which has exactly them and no
  // per-part check. That parity, not speed, is why they are kept: they add no
  // coverage at all, and deleting any one of them, or all three, fails no test
  // (measured). Only the `depth < 0` check above is an early exit; these two run
  // after the whole scan and save only a walk over the parts. Kept as
  // the shared spelling until #4125 merges the copies.
  return parts.every(isLoneStepToken) ? parts : null;
}

/**
 * Is `part` exactly ONE STEP argument, all the way down? Surrounding whitespace
 * is ignored, because a record may carry it and this must not refuse a record
 * it could rewrite. An empty part passes, as an empty slot is accepted above.
 */
function isLoneStepToken(part: string): boolean {
  const text = part.trim();
  return text === '' || skipToken(text, 0) === text.length;
}

/**
 * Index just past the one token starting at `from`, or -1 when the text there
 * is not one token. The forms, per ISO 10303-21: a string (`'...'`, `''`
 * escaping an apostrophe), a list (`(...)`), or a bare run (`$`, `*`, `#123`, a
 * number, an enumeration `.T.`, a binary `"0F"`) optionally applied to a list
 * (`IFCINTEGER(3)`).
 *
 * Deliberately loose about what a bare run CONTAINS and strict only about where
 * it may end: this is not a STEP validator and must not become one. A list's
 * elements are held to the same rule, so a fragment left by a phantom string
 * terminator is caught wherever it lands. Nesting is carried in `depth` rather
 * than by recursing, so a pathologically nested record (this text comes from a
 * file) refuses instead of overflowing the stack.
 */
function skipToken(text: string, from: number): number {
  let i = from;
  let depth = 0;
  let expectToken = true;

  for (;;) {
    i += countWhitespace(text, i);
    const char = text[i];

    if (expectToken) {
      // A list element may be empty (`(1,,2)`), as a top-level slot may be.
      if (depth > 0 && (char === ',' || char === ')')) {
        expectToken = false;
        continue;
      }
      if (char === "'") {
        i = skipString(text, i);
        if (i < 0) return -1;
      } else if (char === '(') {
        depth++;
        i++;
        continue; // the list's first element is still a token to read
      } else {
        const start = i;
        while (i < text.length && !isTokenBreak(text[i])) i++;
        // Nothing consumed: the end of the text, or a separator where a token
        // belongs.
        if (i === start) return -1;
        const afterKeyword = i + countWhitespace(text, i);
        if (text[afterKeyword] === '(') {
          depth++;
          i = afterKeyword + 1;
          continue;
        }
      }
      expectToken = false;
      continue;
    }

    // A token just closed, so only `,` or `)` may follow. At depth zero the
    // token was the whole argument.
    if (depth === 0) return i;
    if (char === ')') {
      depth--;
      i++;
      continue;
    }
    if (char !== ',') return -1;
    i++;
    expectToken = true;
  }
}

/** Index just past the string starting at `from`, or -1 if it never closes. */
function skipString(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] !== "'") continue;
    if (text[i + 1] === "'") i++;
    else return i + 1;
  }
  return -1;
}

/**
 * Can this character only begin or separate another token?
 *
 * `/` is in the set for the STEP block comment, which opens with `/*`. Breaking
 * on the OPENER is enough, and is why there is no comment state machine here: a
 * comment can only sit where a token or a separator belongs, and either way the
 * `/` ends the bare run short of the part's end, so `isLoneStepToken` refuses
 * the part however the comment is written. `*` is deliberately NOT in the set,
 * because it is the derived-attribute marker and a token in its own right, so
 * breaking on it would refuse `$,$,*`.
 */
function isTokenBreak(char: string): boolean {
  return (
    char === "'" ||
    char === '(' ||
    char === ')' ||
    char === ',' ||
    char === '/' ||
    char === ' ' ||
    char === '\t'
  );
}

/**
 * How many whitespace characters run from `from`.
 *
 * Space and tab only, where every NAMED STEP whitespace set in this repo
 * (`is_step_space`, `isSpaceByte`, `isAsciiSpace`, `STEP_TRIVIA`) is the six
 * characters ` \t\n\r\x0b\x0c`. That is safe here only because the caller
 * splits on newlines before this ever runs. `\n` and `\r` are in neither this
 * set nor {@link isTokenBreak}, so a bare run spans them silently and two tokens
 * separated by a newline come back as ONE part (measured: `'$\n$'` splits to
 * `["$\n$"]`, where `'$ $'` and `'$\t$'` are refused). That is the same
 * token-ending-where-it-cannot defect this module exists to catch, unreachable only
 * because the caller pre-splits on newlines. #4163's multi-line work would
 * start feeding real multi-line argument lists through here; widen both sets then
 * rather than relying on that accident.
 */
function countWhitespace(text: string, from: number): number {
  let n = 0;
  while (from + n < text.length && (text[from + n] === ' ' || text[from + n] === '\t')) n++;
  return n;
}
