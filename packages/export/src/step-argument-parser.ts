/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
 * parentheses and quoted strings. Used by `applyAttributeMutations`.
 */
export function splitTopLevelArgs(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    current += char;

    if (inString) {
      if (char === '\'') {
        if (text[i + 1] === '\'') {
          current += text[i + 1];
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (char === '\'') {
      inString = true;
      continue;
    }

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
 * The regex only pins the two ENDS of the record — `#N=CLASS(` and `);`. Text
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
  const match = entityText.match(/^(#\d+\s*=\s*\w+\()([\s\S]*)(\)\s*;)\s*$/);
  if (!match) return null;

  const [, prefix, attrsText, suffix] = match;
  const attrs = splitTopLevelStepArguments(attrsText);
  // Load-bearing, and covered: the bounds check below READS `attrs.length`, so a
  // null reaches it as a TypeError rather than falling through to a rejection.
  // Deleting this line fails exactly the three malformed-input cases in
  // `step-argument-parser.test.ts` — unterminated string, unbalanced list, stray
  // closing paren — which throw instead of returning null. Kept as its own line,
  // not folded into that check, because "could not scan it" and "that slot is
  // past the end" are different facts about the input.
  if (attrs === null) return null;
  // A negative or fractional slot must not reach the assignment below: it would
  // set a NAMED PROPERTY on the array rather than an element, `join` would skip
  // it, and this would hand back the line unchanged — but non-null, which the
  // contract above says means the replacement happened. `rewriteTypeOwnedPsetLine`
  // reads that as `repointed: true` and would report a repoint that never
  // occurred. Unreachable today (the only slot is a constant), guarded because
  // the function is exported and the non-null contract is load-bearing.
  if (!Number.isInteger(attrIndex) || attrIndex < 0 || attrIndex >= attrs.length) return null;

  attrs[attrIndex] = replacement;
  return `${prefix}${attrs.join(',')}${suffix}`;
}

/**
 * Split a STEP argument list on top-level commas while preserving nested syntax,
 * or null when the text is not a well-formed argument list.
 *
 * Similar to `splitTopLevelArgs` but uses a slightly different accumulation style
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
  let inString = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === "'") {
      current += char;
      if (inString && i + 1 < input.length && input[i + 1] === "'") {
        current += input[i + 1];
        i++;
        continue;
      }
      inString = !inString;
      continue;
    }

    if (!inString) {
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
    }

    current += char;
  }

  if (inString || depth !== 0) return null;
  parts.push(current);
  return parts;
}
