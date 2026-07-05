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
 * Compile a name pattern into a predicate. `/body/flags` compiles to a RegExp;
 * anything else (including a malformed literal, which is logged) becomes an
 * exact, case-sensitive match.
 */
export function compileNameMatcher(pattern: string): NameMatcher {
  const cached = matcherCache.get(pattern);
  if (cached) return cached;

  const re = parseRegexLiteral(pattern);
  const matcher: NameMatcher = re ? (name) => re.test(name) : (name) => name === pattern;

  if (matcherCache.size >= CACHE_CAP) matcherCache.clear();
  matcherCache.set(pattern, matcher);
  return matcher;
}

/**
 * Parse a `/body/flags` regex literal, or return null for a plain name. A
 * malformed literal is NOT silently swallowed: it's logged and treated as a
 * plain name (so it matches only itself), keeping behaviour predictable.
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
