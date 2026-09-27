/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A shared guard against catastrophic-backtracking (ReDoS) regular
 * expressions compiled from untrusted, caller-supplied pattern text —
 * an IDS `<xs:pattern>` facet, a bulk-edit "name pattern" field, or any
 * other regex source that did not originate in this codebase.
 *
 * This is a heuristic, not a complete defence. It rejects the
 * well-known catastrophic-backtracking shapes (a quantified group
 * containing another quantifier — `(a+)+`, `(a+)*`, `(.*)+`, `(.*)*`
 * and siblings) and caps pattern length. It does not analyse arbitrary
 * regex structure for worst-case backtracking cost, so a pattern
 * shaped differently from these known forms can still be exploitable.
 * A complete defence would run the match off the main thread with a
 * timeout, or use a linear-time engine (e.g. `re2-wasm`); neither is
 * done here. This module previously existed, in a slightly different
 * form, only inside `@ifc-lite/extensions`'s bundle-test runner — it is
 * factored out here so every caller-supplied-regex call site (IDS
 * pattern matching, bulk-edit name patterns, extension test regexes)
 * shares one implementation instead of drifting copies.
 */

/**
 * Patterns longer than this are rejected outright, regardless of shape.
 * A generous cap: legitimate IDS/name patterns are short; this exists
 * as a cheap secondary control, not the primary defence (a 7-character
 * pattern like `(a+)+$` is already catastrophic, so a length cap alone
 * does not save you — see `hasCatastrophicBacktrackingShape`).
 */
export const MAX_GUARDED_REGEX_PATTERN_LENGTH = 256;

/**
 * Thrown when a caller-supplied regex pattern is rejected by the guard.
 * Callers that want the rejection to surface as a validation error
 * (rather than a thrown exception terminating the whole run) should
 * catch this and turn it into their own error/result shape.
 */
export class UnsafeRegexPatternError extends Error {
  constructor(
    /** The rejected pattern, verbatim. */
    public readonly pattern: string,
    /** Human-readable reason the pattern was rejected. */
    public readonly reason: string
  ) {
    super(`unsafe regex pattern rejected (${reason}): ${JSON.stringify(pattern)}`);
    this.name = 'UnsafeRegexPatternError';
  }
}

/**
 * Cheap shape check for the well-known catastrophic-backtracking regex
 * forms: a quantifier (`+`, `*`, `{n,}`) inside a group, itself followed
 * by another quantifier — `(a+)+`, `(a+)*`, `(.*)+`, `(.*)*` and their
 * siblings. Does not attempt to analyse nested groups beyond one level,
 * or catastrophic shapes built from alternation (e.g. `(a|a)*`) — see
 * the module doc comment.
 *
 * Implemented as a manual scan, not a single regex against the pattern
 * string. A naive `/\([^()]*[+*][^()]*\)\s*[+*{]/` scan is blind to
 * character classes: `[^()]*` cannot cross a `)` written *inside* a
 * `[...]` class (e.g. the harmless-looking `)` in `[)]`), so a pattern
 * like `^(a+[)]?a+)+$` desyncs the scan's idea of where the group ends
 * and the check never fires — even though the pattern is genuinely
 * catastrophic (it is `(a+)+` with a no-op optional literal `)` spliced
 * in). The scan below tracks whether it is inside an unescaped `[...]`
 * class and, while inside one, does not treat `(` or `)` as group
 * delimiters at all — matching how the regex engine itself parses them.
 * It also respects backslash escapes so `\(`, `\)`, and `\[` are never
 * mistaken for real syntax.
 */
export function hasCatastrophicBacktrackingShape(pattern: string): boolean {
  const isEscaped = (s: string, idx: number): boolean => {
    let count = 0;
    let i = idx - 1;
    while (i >= 0 && s[i] === '\\') {
      count++;
      i--;
    }
    return count % 2 === 1;
  };

  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '(' || isEscaped(pattern, i)) continue;

    let depth = 1;
    let innerQuantified = false;
    let inClass = false;
    let j = i + 1;
    for (; j < pattern.length && depth > 0; j++) {
      const c = pattern[j];
      if (c === '\\') {
        j++; // skip the escaped character, whatever it is
        continue;
      }
      if (inClass) {
        if (c === ']') inClass = false;
        continue; // parens and quantifiers inside a class are literal
      }
      if (c === '[') {
        inClass = true;
        continue;
      }
      if (c === '(') {
        depth++;
        continue;
      }
      if (c === ')') {
        depth--;
        continue;
      }
      if (depth === 1 && (c === '+' || c === '*' || c === '{')) innerQuantified = true;
    }
    if (depth !== 0) continue; // unbalanced -- let `new RegExp` report the syntax error

    const closeIdx = j - 1; // index of this group's matching ')'
    const after = pattern[closeIdx + 1];
    if (innerQuantified && (after === '+' || after === '*' || after === '{')) return true;
  }
  return false;
}

/**
 * Validate `pattern` against the length cap and the catastrophic-shape
 * check. Throws {@link UnsafeRegexPatternError} when either check
 * rejects it; returns normally (no value) when the pattern is safe to
 * compile. Does not compile the pattern itself — callers still need
 * their own `new RegExp(...)`, possibly after their own further
 * transformation (e.g. XSD → JS translation, anchoring).
 */
export function assertGuardedRegexPattern(
  pattern: string,
  opts?: { maxLength?: number }
): void {
  const maxLength = opts?.maxLength ?? MAX_GUARDED_REGEX_PATTERN_LENGTH;
  if (pattern.length > maxLength) {
    throw new UnsafeRegexPatternError(pattern, `exceeds ${maxLength}-character limit`);
  }
  if (hasCatastrophicBacktrackingShape(pattern)) {
    throw new UnsafeRegexPatternError(pattern, 'catastrophic-backtracking shape');
  }
}

/**
 * Guarded `new RegExp(...)`: validates `pattern` with
 * {@link assertGuardedRegexPattern} (throwing {@link UnsafeRegexPatternError}
 * on rejection) and only then compiles it with the JS `RegExp`
 * constructor, which itself may throw `SyntaxError` for a malformed
 * pattern the guard did not reject.
 */
export function compileGuardedRegex(
  pattern: string,
  flags?: string,
  opts?: { maxLength?: number }
): RegExp {
  assertGuardedRegexPattern(pattern, opts);
  return new RegExp(pattern, flags);
}
