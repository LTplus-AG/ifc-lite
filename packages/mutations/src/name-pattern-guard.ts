/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shallow ReDoS defence for `BulkQueryEngine`'s `criteria.namePattern`,
 * mirroring `packages/extensions/src/testing/runner.ts`'s
 * `MAX_REGEX_PATTERN_LENGTH` / `hasRedosShape` guard, and independently
 * duplicated (for the same reason) by `packages/ids/src/constraints/xsd-regex.ts`'s
 * `unsafeXsdPatternReason` and `packages/lists/src/name-pattern.ts`'s
 * `unsafeNamePatternReason`. This package has no dependency edge on either —
 * and this machine cannot add a workspace edge (would need `pnpm install`) —
 * so this is a FOURTH deliberate duplicate, not an independent design. The
 * real fix is extracting all four into one shared internal module once a
 * workspace change is possible; this instance is further evidence that the
 * extraction is overdue.
 *
 * `select()` hands the compiled RegExp straight to `.test()` inside a
 * `candidates.filter()` loop over every candidate entity's name — unlike a
 * single form-validation check, the per-entity cost multiplies across the
 * whole candidate set, and this path drives bulk property edits, not just a
 * read-only query.
 *
 * Like its siblings, this is a SHAPE HEURISTIC, not a complete defence: it
 * catches the textbook `(...+)+` / `(...+)*` / `(.*)+` / `(.*)*` forms, not
 * every catastrophic pattern a determined author could construct. A real fix
 * (a Worker + timeout, or `re2-wasm`) is future work.
 */
const MAX_NAME_PATTERN_LENGTH = 256;

/** Quantifier inside a group, immediately followed by another quantifier. */
function hasCatastrophicBacktrackingShape(source: string): boolean {
  return /\([^()]*[+*][^()]*\)\s*[+*{]/.test(source);
}

/**
 * Returns a human-readable rejection reason when `source` is not safe to
 * compile and run `.test()` with, or `undefined` when it's fine. Pure, never
 * throws — the caller decides how to surface the reason.
 */
export function unsafeNamePatternReason(source: string): string | undefined {
  if (source.length > MAX_NAME_PATTERN_LENGTH) {
    return `exceeds the ${MAX_NAME_PATTERN_LENGTH}-character limit (${source.length} characters)`;
  }
  if (hasCatastrophicBacktrackingShape(source)) {
    return 'has a catastrophic-backtracking shape (a quantified group directly wrapped in another quantifier)';
  }
  return undefined;
}

/** Throws (naming the pattern and reason) when `unsafeNamePatternReason` flags `source`. */
export function assertSafeNamePattern(source: string): void {
  const reason = unsafeNamePatternReason(source);
  if (reason) throw new Error(`BulkQueryEngine: unsafe namePattern ${JSON.stringify(source)} — ${reason}`);
}
