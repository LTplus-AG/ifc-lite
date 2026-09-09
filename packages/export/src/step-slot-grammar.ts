/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-slot half of the STEP argument reader: given ONE part that
 * `splitTopLevelStepArguments` (`step-argument-parser.ts`) separated on a
 * top-level comma, is that part a single well-formed STEP value?
 *
 * Split out of `step-argument-parser.ts` because the two answer different
 * questions and only one of them recurses. The splitter is a flat scan over the
 * whole argument list; this is a small recursive-descent grammar over one slot,
 * and it is the recursion that needs the bound documented below. Keeping them in
 * one file also put that file one line under the module-size ratchet.
 */

/**
 * How deep a slot's parentheses may nest before the slot is refused.
 *
 * The grammar below is recursive descent — `parseValue` -> `parseParenList` ->
 * `parseValue`, two stack frames per nesting level — over text this process did
 * not write. Unbounded, deep enough nesting exhausts the JS stack and throws a
 * `RangeError`, and a throw is a THIRD outcome for a function whose two callers
 * (`replaceStepArgument`, and every by-index writer behind
 * `splitTopLevelStepArguments`) are written against exactly two: parts, or
 * `null` meaning "this edit cannot be made". A malformed or adversarial file
 * would abort the whole export instead of refusing one edit. Bounding the
 * nesting and returning `null` past the bound is what makes the contract total.
 *
 * The number is picked between two measurements taken on 2026-09-09 (#4213):
 *
 *   - REAL NESTING. Over the repo's whole `tests/models` corpus (122 `.ifc`
 *     files, 1.4 GB), the deepest paren nesting inside any top-level slot of any
 *     record is 3 — the record-level maximum is 4, and one of those is the slot
 *     itself. The deepest shape in the corpus is
 *     `IFCINDEXEDPOLYCURVE(#307,(IFCLINEINDEX((1,2)),...),.F.)`.
 *   - THE STACK. In a fresh Node 22 process the deepest slot this grammar could
 *     validate before throwing `RangeError` was 3763 (eight fresh-process
 *     bisections, all eight identical); under vitest, 3768. That floor is the
 *     COLD one: once V8 has optimised the frames the same bisection reaches
 *     ~7900 in the same process, so the low number is the one to design against,
 *     and a real export calls this from far deeper in its own stack than a
 *     bisection harness does.
 *
 * 64 is ~21x the deepest nesting real files use and ~59x below the shallowest
 * depth measured to throw: it refuses nothing the corpus contains, and it is
 * reached long before the stack is. Both figures are historical, not
 * invariants: the corpus can gain a file and V8 can change its frame size. What
 * must stay true is the ORDER — comfortably above real nesting, far below the
 * crash floor — and `step-argument-parser.test.ts` pins the two ends of the
 * bound itself, plus one depth measured to throw before it existed.
 *
 * Deliberately NOT mirrored into the two sibling grammars. `step_slot.rs`'s
 * `is_well_formed_step_slot` and `packages/cli/src/commands/step-args.ts`'s
 * `skipToken` are both flat loops with an explicit `depth` counter — the CLI
 * one says so in its own docstring, in as many words — so neither has a stack
 * to exhaust and neither needs a bound; adding one there would only invent a
 * refusal. This grammar was the odd one out, not the one setting the rule.
 *
 * The implementations therefore diverge on what they ACCEPT at extreme depth,
 * which is why this is not in `rust/export/tests/fixtures/step_refuse_vectors.json`
 * — that fixture pins agreement on refusals only, and pinning an accept-side
 * divergence would freeze the divergence as agreement (#4125).
 */
const MAX_SLOT_NESTING_DEPTH = 64;

/**
 * Whether `part` — one slot `splitTopLevelStepArguments` already separated on
 * a top-level comma, raw text including any surrounding whitespace/comments —
 * is a single well-formed STEP value (a string literal, a binary literal
 * (`"..."`), `$`, `*`, a bare keyword / enumeration / number / `#`-reference
 * token, or a typed value or list `NAME(...)` / `(...)`), or is empty.
 *
 * Empty is deliberately accepted, matching `splitTopLevelStepArguments`'s
 * docstring: `a,,b` is one empty part, not a rejection, so slot indices after it
 * stay aligned with what the entity parser counts. A part that is ONLY a comment
 * (no value) is NOT given that same pass — a lone `/* c *​/` between two commas
 * is not a value at all, so treating it as one more empty slot is exactly the
 * index shift that produces a phantom slot; rejecting the whole split is the
 * correct answer there, same as any other malformed argument list.
 *
 * A `/` that is not opening a comment cannot be swallowed into a bare token:
 * it is outside every token's character set, so it stops the scan and the
 * top-of-function "consumed to the end" check then fails the whole part.
 *
 * Nesting past {@link MAX_SLOT_NESTING_DEPTH} is refused like any other
 * malformed part, for the reason recorded on that constant.
 */
export function isWellFormedStepSlot(part: string): boolean {
  if (part.trim() === '') return true;

  let i = 0;
  const n = part.length;

  const skipTrivia = (): void => {
    for (;;) {
      while (i < n && /\s/.test(part[i])) i++;
      if (part[i] === '/' && part[i + 1] === '*') {
        const end = part.indexOf('*/', i + 2);
        if (end === -1) {
          i = n; // unterminated: leave content unconsumed so parseValue fails
          return;
        }
        i = end + 2;
        continue;
      }
      break;
    }
  };

  /**
   * `depth` is how many parens are open around this list — 1 for a list that is
   * the slot's own outermost `(`. Checked on ENTRY, before any recursion, so the
   * frame budget is spent by the check rather than by the call it guards.
   */
  const parseParenList = (depth: number): boolean => {
    if (depth > MAX_SLOT_NESTING_DEPTH) return false;
    // Caller has already consumed the opening '('.
    skipTrivia();
    if (part[i] === ')') {
      i++;
      return true;
    }
    for (;;) {
      if (!parseValue(depth)) return false;
      skipTrivia();
      if (part[i] === ',') {
        i++;
        skipTrivia();
        continue;
      }
      if (part[i] === ')') {
        i++;
        return true;
      }
      return false;
    }
  };

  const parseValue = (depth: number): boolean => {
    skipTrivia();
    if (i >= n) return false;
    const c = part[i];

    if (c === "'") {
      i++;
      while (i < n) {
        if (part[i] === "'") {
          if (part[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          return true;
        }
        i++;
      }
      return false; // unterminated string
    }

    if (c === '(') {
      i++;
      return parseParenList(depth + 1);
    }

    // Binary literal (ISO 10303-21 `"..."`, e.g. `"0123ABC"` — an
    // IfcBinary-typed value, distinct from the `'...'` string literal above.
    // Unlike a string, `"` has no doubled-quote escape in STEP: ifcopenshell's
    // tokenizer (`IfcParse.cpp`, `GeneralTokenPtr`/`IfcSpfLexer::Next`)
    // classifies a token as binary purely by its leading `"` and does not
    // decode escapes inside it, so the first following `"` ends the literal.
    if (c === '"') {
      i++;
      while (i < n && part[i] !== '"') i++;
      if (i >= n) return false; // unterminated binary literal
      i++;
      return true;
    }

    if (c === '$' || c === '*') {
      i++;
      return true;
    }

    // Bare token: keyword, enumeration (`.NOTDEFINED.`), number (incl.
    // exponent), or an `#`-prefixed entity reference.
    const start = i;
    while (i < n && /[A-Za-z0-9_.+\-#]/.test(part[i])) i++;
    if (i === start) return false;

    // A typed value: NAME(...), trivia tolerated before '(' the same way
    // `RECORD_PREFIX_RE` tolerates it before a record's own '('.
    skipTrivia();
    if (part[i] === '(') {
      i++;
      return parseParenList(depth + 1);
    }
    return true;
  };

  if (!parseValue(0)) return false;
  skipTrivia();
  return i === n;
}
