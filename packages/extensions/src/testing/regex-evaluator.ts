/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `expect.regex` matcher of the bundle test runner: the injectable
 * evaluator (#4482) and the guards that run before it. Split out of
 * `runner.ts` so that module stays within its size budget.
 */

import {
  MAX_GUARDED_REGEX_PATTERN_LENGTH,
  hasCatastrophicBacktrackingShape,
} from '@ifc-lite/regex-guard';

/** Outcome of evaluating one `expect.regex` matcher against the test's text. */
export interface RegexEvalResult {
  matched: boolean;
}

/**
 * Evaluates a regex pattern against text and resolves with the match
 * result. Throws (a rejected promise) on both an invalid pattern and a
 * timeout/failure — callers don't need a separate error variant, since
 * `checkRegexExpectation`'s catch branch already handles a thrown
 * `new RegExp` the same way either kind of failure would need to be
 * reported.
 *
 * The default (`defaultRegexEvaluator`) runs `new RegExp(...).test(...)`
 * synchronously in-process, which is exactly what the runner has always
 * done — CLI and test callers get byte-identical behaviour. A host that
 * wants the actual work to run somewhere else (e.g. the viewer running it
 * in a Worker with a timeout, off the main UI thread) supplies its own
 * evaluator via `RunBundleTestsOptions.evaluateRegex`.
 */
export type RegexEvaluator = (pattern: string, text: string) => Promise<RegexEvalResult>;

/** Synchronous, in-process default: today's `new RegExp(pattern).test(text)`. */
export const defaultRegexEvaluator: RegexEvaluator = (pattern, text) => {
  try {
    return Promise.resolve({ matched: new RegExp(pattern).test(text) });
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
};

/**
 * Apply one `expect.regex` matcher. Returns the failure reason, or
 * `undefined` when the pattern matched. `text` is the test result's text
 * representation (`undefined` when it has none).
 */
export async function checkRegexExpectation(
  pattern: string,
  text: string | undefined,
  evaluateRegex: RegexEvaluator,
): Promise<string | undefined> {
  if (text === undefined) {
    return `regex: result has no text representation`;
  }
  if (pattern.length > MAX_GUARDED_REGEX_PATTERN_LENGTH) {
    // Length cap is a shallow defence (`(a+)+$` is 6 chars and
    // catastrophic). The real boundary is drag-drop side-loading
    // (ExtensionsPanel.tsx), not a future registry (deferred
    // Phase-5, see 10-registry-and-signing.md): "Run tests" or
    // RepairQueuePanel's "Run check" reach runBundleTests. This cheap
    // check runs unconditionally, in-process, before `evaluateRegex`
    // is ever called — it does not depend on the evaluator bounding
    // execution time.
    return `regex: pattern exceeds ${MAX_GUARDED_REGEX_PATTERN_LENGTH}-char limit`;
  }
  if (hasCatastrophicBacktrackingShape(pattern)) {
    // Cheap shape check for the well-known catastrophic-backtracking
    // patterns: `(...+)+`, `(...+)*`, `(.*)+`, `(.*)*` and their
    // siblings. Surfaces obvious ReDoS in the test runner.
    return `regex: pattern has catastrophic-backtracking shape`;
  }
  try {
    const { matched } = await evaluateRegex(pattern, text);
    return matched ? undefined : `regex: pattern ${pattern} did not match`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A genuinely malformed pattern throws `SyntaxError` — both
    // `defaultRegexEvaluator` and `RegexWorkerClient.evaluate`
    // (apps/viewer's regex-worker-client.ts) preserve that; anything else
    // an evaluator rejects with (timeout, disposed, worker failed to
    // start) is a plain `Error` and must not read as if the author's
    // pattern were the problem (#4505 finding A).
    return err instanceof SyntaxError
      ? `regex: invalid pattern ${pattern}: ${message}`
      : `regex: evaluation failed for pattern ${pattern}: ${message}`;
  }
}
