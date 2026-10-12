/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IDSSpecification, IDSSpecificationResult } from '../types.js';

/**
 * The result of a specification whose evaluation threw: FAILED with the
 * reason, never a silent pass (#4259), and never the end of the whole run.
 * A rejected `xs:pattern` (`UnsafeRegexPatternError`) is the usual cause;
 * any other error now stays with its own specification too, so the others
 * keep their verdicts, as `runRuleSet` in @ifc-lite/rules already does.
 */
export function unevaluableSpecificationResult(
  spec: IDSSpecification,
  err: unknown
): IDSSpecificationResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    specification: spec,
    status: 'fail',
    applicableCount: 0,
    passedCount: 0,
    failedCount: 0,
    passRate: 0,
    entityResults: [],
    error: `Specification could not be evaluated: ${message}`,
  };
}

/** A host's cancellation, which ends the run instead of failing one specification (as in `runRuleSet`). */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
