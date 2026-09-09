/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { hasCatastrophicBacktrackingShape } from '@ifc-lite/regex-guard';

/**
 * A `where(...)` / `--where` predicate needs to compare a stored property or
 * quantity value against a caller-supplied filter value. Three call sites
 * implemented this independently (the CLI's `HeadlessBackend`, the MCP
 * backend, and the `ifc-lite query --where` flag), and a fourth — the
 * viewer's embedded SDK backend, `bim`'s primary consumption path — never
 * picked up the boolean-normalization/case-insensitive-`contains` fix the
 * other three carry, so the identical `bim.query().where(...)` call silently
 * matched fewer rows there than in the CLI/MCP. This module is the single
 * home for that comparison so the four call sites can't drift apart again.
 */

export type FilterComparisonOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'exists' | 'matches';

/**
 * Normalize boolean-like values for comparison. IFC STEP encodes booleans as
 * `.T.`/`.F.` tokens; parsed property values are typically real JS booleans
 * by the time they reach a filter, but a caller-supplied filter value (a CLI
 * flag, a raw mutation) may arrive as one of the string spellings instead.
 * Collapsing every spelling to the same `'true'`/`'false'` string lets the
 * `String(a) === String(b)` comparisons below treat them all as equal.
 */
export function normalizeBooleanValue(value: unknown): unknown {
  if (value === true || value === '.T.' || value === 'true' || value === 'TRUE') return 'true';
  if (value === false || value === '.F.' || value === 'false' || value === 'FALSE') return 'false';
  return value;
}

/**
 * `matches`'s `expected` side is a bare regex *source* — no `/…/` delimiters,
 * no flag suffix. That is deliberately the same shape `SelectorText`'s
 * `{ kind: 'regex', source }` carries in `packages/query/src/selector/ast.ts`
 * (`readRegex` in `tokenize.ts` already strips the delimiters and unescapes
 * `\/`), so a selector adapter can hand a parsed regex filter's `source`
 * straight to this operator without re-deriving delimiter stripping.
 * Matching is case-sensitive by construction (no implicit `i` flag, unlike
 * `contains`, which lowercases both sides) — the pattern's author controls
 * case sensitivity, not this function.
 *
 * `expected` is caller-supplied — the CLI `--where ~=` flag and, more
 * pointedly, the MCP `query_entities` tool's `property.value`, which is
 * agent/LLM-influenced input running synchronously on the MCP server's one
 * main thread. `new RegExp(source).test(actual)` is not a safe operation on
 * untrusted `source`: a pattern shaped like `^(a+)+$` against a
 * non-matching subject is exponential in subject length in V8's backtracking
 * engine (measured: a 35-character non-matching subject already exceeds
 * 30s; see `filter-predicate.test.ts`'s catastrophic-pattern test for the
 * reproduction). `compileFilterPattern` below rejects patterns matching that
 * shape, and any other invalid pattern, *before* compiling — loudly, by
 * throwing, not by returning `false`. That intentionally changes this
 * function's contract from "never throws" (the shape every other
 * `compareFilterValue` branch keeps: `>` against a non-numeric `expected` is
 * `Number(x) > NaN`, already `false`, never a throw) to "throws on a
 * rejected or malformed pattern" — the two are different failure classes.
 * Silently returning `false` for an operator-coercion mismatch (a caller
 * error at the value level) is fine; silently returning `false` for a
 * pattern this repo refuses to run is not, per this repo's existing
 * fail-loud precedent for caller-supplied input (`--limit`/`--offset`
 * validate up front with `fatal()` rather than silently clamping). A caller
 * that wants to reject a pattern even earlier (e.g. a selector adapter
 * validating user input before a query starts) still can — that guidance
 * from the previous version of this comment still holds — but it is no
 * longer required for safety, because this layer now refuses unsafe input
 * itself.
 *
 * This is a heuristic input constraint, not a proof of linear-time
 * execution — see `compileFilterPattern`'s own doc comment for what it does
 * and does not catch, and the PR description for the alternatives (a
 * wall-clock timeout, a linear-time engine) this environment ruled out.
 */
function matchesRegex(actual: unknown, expected: unknown): boolean {
  const re = compileFilterPattern(String(expected));
  return re.test(String(actual));
}

/** Upper bound on a `matches` pattern's source length. Chosen to comfortably
 * cover realistic IFC identifier/name/type patterns (`^IfcWall`,
 * `Pset_.*Common`, GlobalId-shaped alternations) while still being short
 * enough that {@link hasNestedQuantifier}'s O(n^2) scan and any surviving
 * backtracking risk stay cheap. NOTE: this cap alone does not neutralize
 * catastrophic backtracking — the measured repro's worst timing (>30s,
 * killed) came from a 35-character pattern/subject, far under any length
 * cap generous enough to be usable. Length is a blunt secondary control;
 * {@link hasNestedQuantifier} is the control actually aimed at the measured
 * failure shape. */
const MAX_FILTER_PATTERN_LENGTH = 200;

/** Thrown by {@link compileFilterPattern} for a pattern this module refuses
 * to compile, whether because it is not valid regex syntax or because it
 * matches a known catastrophic-backtracking shape. Named so a caller that
 * wants to distinguish "your pattern was rejected" from other errors can
 * `instanceof` it; every current caller lets it propagate as a loud failure
 * (the CLI's top-level `main().catch` prints `Error [<command>]: <message>`
 * and exits 1; the MCP server's generic tool-call catch turns it into an
 * `isError: true` result; the viewer SDK adapter's `entities()` already
 * throws `TypeError` for other invalid input in this same method, so this
 * joins that precedent rather than inventing a new one). */
export class InvalidFilterPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidFilterPatternError';
  }
}

/**
 * Detect the specific catastrophic-backtracking shape this module measured
 * and is defending against: a quantified group (`(...)+`, `(...)*`,
 * `(...){m,n}`) whose own contents contain another quantifier at the same
 * nesting depth, e.g. `(a+)+`, `(a*)*`, `(a+){2,}`. Ambiguous nested
 * repetition is the textbook cause of exponential backtracking in a
 * backtracking (non-linear-time) engine like V8's — each extra repeat of
 * the outer quantifier multiplies the number of ways the inner one can
 * partition the same input, and on a non-matching subject the engine tries
 * all of them before giving up.
 *
 * Delegates to `@ifc-lite/regex-guard`'s `hasCatastrophicBacktrackingShape`
 * rather than carrying its own copy of the scan. This module used to hand-roll
 * a paren-depth scan here, independently of the shared guard package added
 * for #4259 (`packages/regex-guard`) — two implementations wrong in the same
 * way for different reasons (see #4318): this module's scan tracked `(`/`)`
 * depth with no awareness of character classes, so a `)` written inside
 * `[...]` (e.g. `^(a+[)]?a+)+$`) desynced the depth count and the check never
 * fired on a genuinely catastrophic pattern. The shared guard now has the
 * same fix (a manual scan that skips from an unescaped `[` to its closing
 * `]`), so routing through it here closes the same bypass without
 * maintaining a second copy.
 *
 * This is still a heuristic, not a backtracking-complexity analyzer: it will
 * reject some patterns that would in fact run fine (a false positive — the
 * user hits a "pattern rejected" error for a pattern that was actually
 * safe), and it will not catch every ReDoS-capable shape (e.g. overlapping
 * alternation like `(a|a)*`). Given this environment cannot add a
 * linear-time regex engine (no dependency install available) or move
 * `.test()` off the main thread onto a wall-clock timeout (a much larger,
 * async-ifying change — see the PR description), this heuristic plus the
 * length cap is the practical, dependency-free mitigation available;
 * residual risk from a shape it misses is real and is stated as such rather
 * than implied away. See {@link compileFilterPattern}, the sole call site.
 */
const hasNestedQuantifier = hasCatastrophicBacktrackingShape;

/** Bounded so a pattern this module has already validated once (the common
 * case: the same `matches` pattern is compiled once, then tested against
 * every candidate entity in a `where`/`--where` query — see
 * `applyWhereFilter`, `matchesPropertyFilter` in both the CLI and MCP
 * packages, and the viewer SDK adapter, none of which vary the pattern
 * per-entity) is compiled exactly once, not once per entity, without
 * requiring every call site to remember to hoist the compile out of its
 * loop itself. Cleared wholesale rather than evicted LRU-style once it
 * would grow past a bound — simpler, and a cache clear just means the next
 * lookup re-validates and re-compiles, which is correct, only slower. */
const FILTER_PATTERN_CACHE_LIMIT = 500;
const filterPatternCache = new Map<string, RegExp>();

/**
 * Validate and compile a `matches` pattern, or throw
 * {@link InvalidFilterPatternError} naming why. See {@link hasNestedQuantifier}
 * and {@link MAX_FILTER_PATTERN_LENGTH} for what is rejected and why;
 * neither rejection depends on ever running the pattern against a subject,
 * so a rejected pattern fails in roughly constant time regardless of how
 * long its would-be matching would have taken.
 */
function compileFilterPattern(pattern: string): RegExp {
  const cached = filterPatternCache.get(pattern);
  if (cached) return cached;

  if (pattern.length > MAX_FILTER_PATTERN_LENGTH) {
    throw new InvalidFilterPatternError(
      `matches: pattern rejected -- ${pattern.length} characters exceeds the ` +
        `${MAX_FILTER_PATTERN_LENGTH}-character limit for a "matches" pattern.`,
    );
  }
  if (hasNestedQuantifier(pattern)) {
    throw new InvalidFilterPatternError(
      `matches: pattern rejected -- it contains a quantified group with another ` +
        `quantifier inside it (e.g. "(a+)+"), a shape that can take exponential ` +
        `time to fail to match on adversarial input. Rewrite the pattern without ` +
        `nesting a quantifier inside a quantified group.`,
    );
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    throw new InvalidFilterPatternError(
      `matches: invalid regular expression ${JSON.stringify(pattern)}: ${(err as Error).message}`,
    );
  }

  if (filterPatternCache.size >= FILTER_PATTERN_CACHE_LIMIT) filterPatternCache.clear();
  filterPatternCache.set(pattern, re);
  return re;
}

/**
 * Evaluate a single comparison operator against a stored value and a
 * filter value. Booleans are normalized first (see {@link normalizeBooleanValue}),
 * and `contains` is case-insensitive — the settled semantics across the
 * CLI/MCP query backends, now shared rather than duplicated.
 *
 * `exists` answers "is this property/quantity present", not "does it carry a
 * non-null value" — a caller passes `actual` here only once it has already
 * confirmed the property was found (e.g. `IFCPROPERTYSINGLEVALUE('FireRating',
 * $,$,$)` is present in its pset with a `$` nominal value, which parses to
 * `null`; it still exists). So `exists` is unconditional true once reached.
 *
 * `matches` is a regex test — see {@link matchesRegex} for the exact
 * delimiter/flag/error contract. It is NOT boolean-normalized: normalizing
 * `true`/`false` to the strings `'true'`/`'false'` before every other
 * operator exists so `.T.`/`true`/`TRUE` compare as equal, which has nothing
 * to do with regex matching, and normalizing first would only make a pattern
 * like `/^\.T\.$/` (deliberately matching the raw STEP token) silently see
 * `'true'` instead.
 */
export function compareFilterValue(actual: unknown, operator: FilterComparisonOp, expected: unknown): boolean {
  if (operator === 'exists') return true;
  if (operator === 'matches') return matchesRegex(actual, expected);
  const normActual = normalizeBooleanValue(actual);
  const normExpected = normalizeBooleanValue(expected);
  switch (operator) {
    case '=': return String(normActual) === String(normExpected);
    case '!=': return String(normActual) !== String(normExpected);
    case '>': return Number(normActual) > Number(normExpected);
    case '<': return Number(normActual) < Number(normExpected);
    case '>=': return Number(normActual) >= Number(normExpected);
    case '<=': return Number(normActual) <= Number(normExpected);
    case 'contains': return String(normActual).toLowerCase().includes(String(normExpected).toLowerCase());
    default: return false;
  }
}
