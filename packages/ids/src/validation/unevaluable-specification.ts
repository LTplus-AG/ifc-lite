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
  return {
    specification: spec,
    status: 'fail',
    applicableCount: 0,
    passedCount: 0,
    failedCount: 0,
    passRate: 0,
    entityResults: [],
    error: `Specification could not be evaluated: ${describeThrown(err)}`,
  };
}

/**
 * The reason text for a thrown value, which never throws itself: a value
 * that cannot be converted to text (`Object.create(null)`, a throwing
 * `toString` or `message`, a revoked proxy) is named by its kind, so its
 * specification still gets a stable diagnostic and the run goes on.
 */
function describeThrown(err: unknown): string {
  try {
    return err instanceof Error ? String(err.message) : String(err);
  } catch {
    // Converting the value to text threw; `typeof` cannot.
    return `the thrown ${err === null ? 'null' : typeof err} cannot be converted to text`;
  }
}

/**
 * A host's cancellation, which ends the run instead of failing one
 * specification: anything thrown with the name `AbortError` (a DOMException,
 * Node's own AbortError, the parser's fallback, or any abort reason
 * `signal.throwIfAborted()` throws, an object such as `{ name: 'AbortError' }`
 * or a function named `AbortError`). Never throws: a value whose name cannot
 * even be read (a revoked proxy, a throwing getter) is not a cancellation.
 */
export function isAbortError(err: unknown): boolean {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return false;
  try {
    return 'name' in err && err.name === 'AbortError';
  } catch {
    // Reading the name threw, so this is no cancellation; it fails its specification.
    return false;
  }
}

/** The host's `onProgress`, able to say whether an error is one it threw itself. */
export type HostProgressCallback<T> = ((progress: T) => void) & {
  /** Whether `err` is what the callback threw: a host failure, which ends the run (#7482). */
  threw(err: unknown): boolean;
};

/**
 * Wrap the host's `onProgress` so that an exception from the callback
 * itself, raised while a specification is being evaluated, propagates
 * instead of becoming that specification's error: a host callback
 * failure is not an unevaluable check.
 */
export function guardHostProgress<T>(
  onProgress: ((progress: T) => void) | undefined
): HostProgressCallback<T> | undefined {
  if (!onProgress) return undefined;
  let thrown: { error: unknown } | undefined;
  return Object.assign(
    (progress: T) => {
      try {
        onProgress(progress);
      } catch (error) {
        thrown = { error };
        throw error;
      }
    },
    // Object.is, so that even a thrown NaN is recognised as the host's.
    { threw: (err: unknown) => thrown !== undefined && Object.is(thrown.error, err) }
  );
}
