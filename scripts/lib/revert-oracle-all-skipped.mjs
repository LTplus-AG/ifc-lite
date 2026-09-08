/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Final-kind classification for a parsed runner result, and the ALL_SKIPPED
 * kind itself. Split out of `revert-oracle.mjs` to keep that file at its
 * recorded module-size budget (the same reason `revert-oracle-python.mjs`,
 * `revert-oracle-rust-features.mjs` and `revert-oracle-plan-runs.mjs` exist) —
 * `parseRunnerOutput`'s merge point already decided NO_TESTS/UNPARSEABLE/
 * ASSERTION_FAILURE/PASS from `{ passed, failed, total }`; this is that same
 * decision with one more branch (#4108).
 *
 * WHY ALL_SKIPPED IS ITS OWN KIND, NOT FOLDED INTO PASS. vitest's and node
 * --test's summary lines count a skipped test into the same `total` as a
 * passed one: vitest's `Tests  2 skipped (2)` parses to
 * `{ passed: 0, failed: 0, total: 2 }` — exactly the shape a
 * `describe.skipIf` guard produces when its fixture is absent (AGENTS.md
 * requires skipping, not throwing, in that case). Nothing ever executed, so
 * scoring that PASS lets the oracle treat a baseline that measured nothing as
 * a clean baseline, and then score an identically-skipped reverted run as an
 * UNOBSERVED "finding about the author's tests" when the truth is nothing
 * was ever measured (#4108).
 *
 * pytest and cargo do not have this gap: `parsePython` already collapses an
 * all-skipped run to `total: 0`, which routes through the existing NO_TESTS
 * path, and cargo's summary line does not fold `ignored` into its `passed +
 * failed` total at all. Only vitest and node --test count skipped tests into
 * `total`, so only their output can reach this branch with `total > 0`.
 *
 * PARTIAL SKIPS ARE NOT FLAGGED. A file where some tests ran and some were
 * skipped still has at least one executed assertion that could have gone red
 * on the revert — real evidentiary value, not a capability gap. Only a
 * WHOLLY skipped file (`passed === 0 && failed === 0`) is vacuous. Do not
 * broaden this to "any skip" — AGENTS.md's own skip-not-throw convention for
 * missing fixtures depends on partial skips being unremarkable.
 */

import { PASS, ASSERTION_FAILURE } from './revert-oracle.mjs';

export const ALL_SKIPPED = 'all-skipped';

/**
 * `parsed` is `{ passed, failed, total }` from a family parser, already past
 * `parseRunnerOutput`'s load-error, NO_TESTS and UNPARSEABLE checks — so
 * `total` is a positive number here, never `0` or `null`.
 */
export function classifyExecuted(parsed) {
  if (parsed.failed > 0) {
    return { kind: ASSERTION_FAILURE, passed: parsed.passed, failed: parsed.failed, total: parsed.total, evidence: parsed.evidence ?? [] };
  }
  if (parsed.passed === 0) {
    return {
      kind: ALL_SKIPPED,
      passed: parsed.passed,
      failed: parsed.failed,
      total: parsed.total,
      evidence: [`runner executed zero of ${parsed.total} collected test(s) (all skipped)`],
    };
  }
  return { kind: PASS, passed: parsed.passed, failed: parsed.failed, total: parsed.total, evidence: [] };
}
