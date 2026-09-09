/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property-set / property NAME matching for list columns and queries.
 *
 * A name wrapped in slashes (`/Qto_.*BaseQuantities/`, optionally with trailing
 * flags such as `/qto_.+/i`) is treated as a regular expression matched against
 * the candidate name; anything else is an exact, case-sensitive string match
 * (the historical behaviour). This lets one column / query pull a value from
 * several property or quantity sets at once — e.g. `NetVolume` from
 * `Qto_WallBaseQuantities` AND `Qto_SlabBaseQuantities` — the way Bonsai's
 * `/regex/` syntax works (issue #1591). IFC set / property names never contain
 * slashes, so the `/.../` form is unambiguous.
 */

import { assertGuardedRegexPattern, UnsafeRegexPatternError } from '@ifc-lite/regex-guard';

type NameMatcher = (name: string) => boolean;

// Compiled matchers are cached by pattern string: `findPropertyEntry` /
// `findQuantityEntry` run per row, and the pattern is fixed per column, so
// without this a regex column would recompile its RegExp for every element.
// Distinct patterns are bounded by the user's column/query configs; the cap is
// a backstop against a pathological loop that mints unique patterns.
const CACHE_CAP = 256;
const matcherCache = new Map<string, NameMatcher>();

/** True when `pattern` uses the `/regex/` form (a valid slash-delimited literal). */
export function isNamePattern(pattern: string): boolean {
  return parseRegexLiteral(pattern) !== null;
}

/**
 * Returns a human-readable rejection reason when `source` is not safe to
 * compile and run `.test()` with, or `undefined` when it's fine. Pure, never
 * throws — delegates to `@ifc-lite/regex-guard`'s `assertGuardedRegexPattern`
 * so this package shares the same catastrophic-backtracking-shape and
 * length-cap checks as `@ifc-lite/ids`, `@ifc-lite/extensions` and
 * `@ifc-lite/mutations`, instead of carrying its own copy. Exposed so a
 * caller that wants to reject a dangerous pattern WITHOUT triggering
 * `compileNameMatcher`'s throw (e.g. a live "does this pattern look right"
 * preview) can check first.
 */
export function unsafeNamePatternReason(source: string): string | undefined {
  try {
    assertGuardedRegexPattern(source);
    return undefined;
  } catch (err) {
    if (err instanceof UnsafeRegexPatternError) return err.reason;
    throw err;
  }
}

/**
 * Compile a name pattern into a predicate. `/body/flags` compiles to a RegExp;
 * anything else (including a malformed literal, which is logged) becomes an
 * exact, case-sensitive match.
 *
 * `compileNameMatcher` hands its returned predicate straight to `.test()`
 * against untrusted data: a viewer list column, an SDK `psetName`/`propName`
 * argument, or an LLM/agent-authored sandbox script's own call arguments
 * (`packages/sandbox/src/bridge-query.ts`'s `property` tool forwards its
 * args unmodified into `sdk.property` → `compileNameMatcher`, and the regex
 * compiles and runs on the HOST's main thread, outside the QuickJS sandbox —
 * a pattern the sandboxed script "owns" can hang the real browser tab). For
 * that reason, before compiling a `/regex/` literal's body, this runs it
 * through `@ifc-lite/regex-guard`'s `assertGuardedRegexPattern`, which
 * rejects the well-known catastrophic-backtracking shapes and overlong
 * patterns.
 *
 * Throws a plain `Error` — naming the pattern and the reason — when the body
 * is syntactically valid but rejected by the guard: unlike a malformed
 * literal, there is no safe fallback here, because the whole point of
 * rejecting it is to never call `.test()` with it. A caller that cannot let
 * an exception propagate (the sandbox bridge, in particular) MUST catch
 * this — see the callers' own comments for why a throw is safe to cross
 * that boundary.
 */
export function compileNameMatcher(pattern: string): NameMatcher {
  const cached = matcherCache.get(pattern);
  if (cached) return cached;

  const re = parseRegexLiteral(pattern);
  if (re) {
    try {
      assertGuardedRegexPattern(re.source);
    } catch (err) {
      if (err instanceof UnsafeRegexPatternError) {
        throw new Error(`[lists] rejected name pattern ${JSON.stringify(pattern)}: ${err.reason}`);
      }
      throw err;
    }
  }
  const matcher: NameMatcher = re ? (name) => re.test(name) : (name) => name === pattern;

  if (matcherCache.size >= CACHE_CAP) matcherCache.clear();
  matcherCache.set(pattern, matcher);
  return matcher;
}

/**
 * Parse a `/body/flags` regex literal, or return null for a plain name. A
 * malformed literal is NOT silently swallowed: it's logged and treated as a
 * plain name (so it matches only itself), keeping behaviour predictable.
 *
 * This only validates SYNTAX (does it compile at all) — `isNamePattern` uses
 * it as-is, unaffected by the ReDoS guard above, because merely
 * *constructing* a RegExp never runs it and so cannot ReDoS; only
 * `compileNameMatcher`'s returned predicate ever calls `.test()`.
 */
function parseRegexLiteral(pattern: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (!m) return null;
  try {
    // Strip the stateful `g`/`y` flags: the compiled matcher is cached and
    // shared across rows, and `.test()` on a global/sticky RegExp advances
    // `lastIndex`, which would make matching alternate true/false per call.
    return new RegExp(m[1], m[2].replace(/[gy]/g, ''));
  } catch (err) {
    console.warn(`[lists] invalid name pattern ${JSON.stringify(pattern)}: ${(err as Error).message}`);
    return null;
  }
}
