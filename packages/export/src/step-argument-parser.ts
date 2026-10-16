/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { stepStringLiteralEnd } from '@ifc-lite/encoding';
import { skipStepComment } from './step-comment-skip.js';
import { isWellFormedStepSlot } from './step-slot-grammar.js';
import { frameArgs, stepRecordFrame } from './step-record-frame.js';

/**
 * The STEP argument parser and rewriter: reading a record's top-level argument
 * list out of its text, and writing one slot back.
 *
 * This is the one text layer that goes the other way from the rest of the
 * export path — everything in `step-serialization.ts` turns a value INTO a
 * token, while these three read tokens back OUT of a line someone else wrote
 * (or that an earlier pass rewrote) and hand them to a caller that edits by
 * slot index. Nothing here depends on exporter state; the input is a string and
 * the output is parts or a rewritten string.
 *
 * They live together because they share one set of rules — quote state,
 * doubled-quote escapes, paren depth, what counts as a slot — and those rules
 * are what a caller has to be able to find when a line comes out wrong. The
 * failure they exist to prevent is silent: a mis-scanned list still produces
 * parts, and writing a slot by index into those parts lands on the wrong
 * argument while reporting success (LTplus-AG/ifc-lite#2470).
 */
/**
 * Split a STEP argument list on top-level commas, respecting nested
 * parens, quoted strings, and comments (#4227). This permissive helper is for
 * already-extracted aggregate/list bodies; whole entity records must go
 * through `readStepSlots` so every slot is validated before mutation.
 */
export function splitTopLevelListItems(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '/' && text[i + 1] === '*') {
      const stop = skipStepComment(text, i); // see skipStepComment's docstring
      current += text.slice(i, stop);
      i = stop - 1;
      continue;
    }

    if (char === '\'') {
      // A literal is copied whole; where it ends is the shared rule, so `''`
      // and a `\S\'` PAGE operand stay inside it (#7589). Unterminated: the rest.
      const end = stepStringLiteralEnd(text, i);
      const stop = end === -1 ? text.length : end;
      current += text.slice(i, stop);
      i = stop - 1;
      continue;
    }
    current += char;

    if (char === '(') {
      depth++;
      continue;
    }

    if (char === ')') {
      depth--;
      continue;
    }

    if (char === ',' && depth === 0) {
      parts.push(current.slice(0, -1).trim());
      current = '';
    }
  }

  // Trailing tokens: only push if there's actual content. The previous
  // `text.endsWith(',')` check pushed an empty trailing token for inputs
  // like `"a,"`, producing `['a', '']` — STEP doesn't allow trailing
  // commas, so the right answer is just `['a']`. Empty interior args
  // (e.g. `"a,,b"` → `['a', '', 'b']`) are still produced because the
  // comma branch above handles them.
  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

export interface StepRecordSlots {
  readonly prefix: string;
  readonly type: string;
  readonly slots: readonly string[];
  readonly suffix: string;
}

/**
 * Parse a complete STEP record into validated, position-addressable slots.
 * The record is framed by `stepRecordFrame` (#7682), so trivia anywhere Part 21
 * allows it (around the `=`, before the `(`, between the `)` and the `;`) is
 * kept in `prefix` / `suffix` rather than making the record unreadable.
 */
export function readStepSlots(entityText: string): StepRecordSlots | null {
  const frame = stepRecordFrame(entityText);
  if (frame === null) return null;
  const slots = splitTopLevelStepArguments(frameArgs(entityText, frame));
  if (slots === null) return null;
  return {
    prefix: entityText.slice(0, frame.head.open + 1),
    type: entityText.slice(frame.head.typeStart, frame.head.typeEnd).toUpperCase(),
    slots,
    suffix: entityText.slice(frame.close),
  };
}

/**
 * Replace ONE top-level argument of a STEP record, by zero-based slot, leaving
 * every other token — and the record's class keyword and id — byte-identical.
 *
 * Takes the LINE, not an expressId: the caller may hold a line that is no
 * longer what the source buffer says. The type-object `HasPropertySets`
 * rewrite is exactly that case — it hands in a line the retype / attribute /
 * positional pipeline has already rewritten, and re-reading the buffer here
 * would throw all of that away (which is how that path used to drop every
 * edit but the pset repoint).
 *
 * Returns null when the text is not a parseable single STEP record or the slot
 * is past the end of the argument list; a null must not be treated as "no
 * change", since the intended replacement did not happen.
 *
 * The frame only pins the two ENDS of the record — `#N=CLASS(` and `);`. Text
 * malformed BETWEEN them is caught by {@link splitTopLevelStepArguments}, which
 * rejects an argument list it could not scan cleanly rather than handing back
 * whatever it accumulated: those parts are not the record's slots, so writing
 * one lands on the wrong argument and reports a success that did not happen
 * (#2470). Silently corrupted output instead of a dropped entity, same class.
 */
export function replaceStepArgument(
  entityText: string,
  attrIndex: number,
  replacement: string,
): string | null {
  const record = readStepSlots(entityText);
  // Load-bearing, and covered: the bounds check below READS `attrs.length`, so a
  // null reaches it as a TypeError rather than falling through to a rejection.
  // Deleting this line fails exactly the three malformed-input cases in
  // `step-argument-parser.test.ts` — unterminated string, unbalanced list, stray
  // closing paren — which throw instead of returning null. Kept as its own line,
  // not folded into that check, because "could not scan it" and "that slot is
  // past the end" are different facts about the input.
  if (record === null) return null;
  const attrs = [...record.slots];
  // A negative or fractional slot must not reach the assignment below: it would
  // set a NAMED PROPERTY on the array rather than an element, `join` would skip
  // it, and this would hand back the line unchanged — but non-null, which the
  // contract above says means the replacement happened. `rewriteTypeOwnedPsetLine`
  // reads that as `repointed: true` and would report a repoint that never
  // occurred. Unreachable today (the only slot is a constant), guarded because
  // the function is exported and the non-null contract is load-bearing.
  if (!Number.isInteger(attrIndex) || attrIndex < 0 || attrIndex >= attrs.length) return null;

  attrs[attrIndex] = replacement;
  return `${record.prefix}${attrs.join(',')}${record.suffix}`;
}

/**
 * Split a STEP argument list on top-level commas while preserving nested syntax,
 * or null when the text is not a well-formed argument list.
 *
 * Similar to `splitTopLevelListItems` but uses a slightly different accumulation style
 * suited for the {@link replaceStepArgument} call-site.
 *
 * ## Why it validates
 *
 * The scan already tracks quote state and paren depth to know where a top-level
 * comma is. It used to ignore the final state, so text that never left a string
 * or never closed a list still produced parts — parts whose boundaries are
 * wherever the scanner happened to be, not the record's slots. Both callers then
 * acted on them: `replaceStepArgument` wrote a slot by index and reported
 * success, and the unit rescale multiplied numbers in whatever argument the
 * mis-split had put them in. Neither could tell, because a broken split looks
 * exactly like a good one.
 *
 * Rejected, because after either of these the parts are no longer the record's
 * arguments — commas were swallowed and everything past them shifted:
 *   - a quote left open at the end (unterminated string);
 *   - a paren depth that does not return to zero, or that ever goes below it
 *     (unbalanced or stray-closing nested list). Both ends matter: a depth that
 *     dips negative and climbs back looks balanced at the end while every comma
 *     in between was read as nested.
 *
 * A part whose parentheses nest deeper than the per-slot grammar's bound is
 * refused the same way — see `MAX_SLOT_NESTING_DEPTH` in `step-slot-grammar.ts`
 * for why that bound exists and how the number was chosen. It is the one
 * rejection here that is not about the record's text being wrong; it is what
 * keeps this function's answer to "parts, or null" total, instead of letting a
 * deeply nested list reach the caller as a thrown `RangeError` nothing handles.
 *
 * An EMPTY top-level slot (`a,,b`, or a trailing comma) is deliberately NOT
 * rejected, though it is invalid STEP. It costs no alignment: an empty argument
 * is ONE part, exactly as the entity parser counts it, so every index still
 * names the attribute it is meant to and the replacement lands where it should.
 * Rejecting it made things strictly worse, and measurably: the parser resolves
 * `HasPropertySets` on such a line, so a session deleting that type object's
 * property set has already had the pset's lines WITHHELD by the time the repoint
 * runs — refuse the repoint and the record keeps a `#id` pointing at a property
 * set the export just dropped. A dangling reference is worse than a
 * still-invalid-but-unchanged empty slot.
 *
 * An empty INPUT is not an empty slot: `#1=IFCFOO();` is a record with no
 * arguments, so it splits to `[]` and any slot request then fails the bounds
 * check in {@link replaceStepArgument} — which is the right answer for a record
 * that has no slots.
 */
export function splitTopLevelStepArguments(input: string): string[] | null {
  if (input.trim() === '') return [];

  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    // See skipStepComment's docstring; isWellFormedStepSlot below still
    // rejects an unterminated comment via skipTrivia.
    if (char === '/' && input[i + 1] === '*') {
      const stop = skipStepComment(input, i);
      current += input.slice(i, stop);
      i = stop - 1;
      continue;
    }

    // A literal is copied whole. Where it ends is the shared rule, so a `\S\'`
    // operand is text, not a closing quote (#7589); one that never closes is an
    // unterminated string, refused.
    if (char === "'") {
      const end = stepStringLiteralEnd(input, i);
      if (end === -1) return null;
      current += input.slice(i, end);
      i = end - 1;
      continue;
    }

    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      // Already past the record's own closing paren: every comma from here
      // would be read as nested and the split is meaningless.
      if (depth < 0) return null;
    } else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (depth !== 0) return null;
  parts.push(current);

  // The three checks above (quote/paren/final-depth) track SCAN state, not
  // slot content. A phantom string can swallow a real boundary — an
  // undoubled `'` inside two different string-typed arguments reads as one
  // string spanning both, so the text between them (`),$,IFCLABEL(` and
  // similar) gets folded into a single part while quote parity and paren
  // depth both stay clean — and a comment sitting alone between two commas
  // (no value of its own) becomes its own phantom slot, shifting every index
  // after it. Both leave every check above satisfied on a slot list that is
  // not the record's actual arguments (#4162). Reject the whole split rather
  // than hand back parts whose boundaries do not correspond to real slots —
  // a null here is what lets `replaceStepArgument`'s by-index write refuse
  // instead of landing on the wrong attribute.
  for (const part of parts) {
    if (!isWellFormedStepSlot(part)) return null;
  }
  return parts;
}
