/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pure classification step behind check-unused-locals.mjs: given one
 * package's ANSI-stripped `tsc --noUnusedLocals` output (already non-zero
 * exit, i.e. tsc reported *something*), decide what that something means.
 *
 * Split out from check-unused-locals.mjs so the branching can be unit-tested
 * directly against captured text, without spawning a real tsc — the case
 * this exists to catch (an unrecognised `TS####` diagnostic shape) is not
 * something the pinned TypeScript version actually emits today, so it can
 * only be exercised as a hand-built string, the same way review reproduced
 * it (PR #2634 review thread).
 */

/**
 * The TypeScript diagnostics that mean "declared and never used". More than
 * one code matters: TS6192 is "all imports in this declaration are unused",
 * which is precisely the dead-import case this check exists for, and
 * treating it as an unrelated error made `apps/viewer` — where those
 * imports were — unmeasurable.
 */
export const UNUSED_CODES = [6133, 6138, 6192, 6196, 6198, 6199];
export const UNUSED_RE = new RegExp(`error TS(${UNUSED_CODES.join('|')}):`, 'g');
export const OTHER_ERROR_RE = new RegExp(`error TS(?!(?:${UNUSED_CODES.join('|')})\\b)\\d+:`, 'g');
// A generic "this looks like a TS diagnostic" signal, independent of the two
// regexes above. Used to tell "tsc printed diagnostics we can fully account
// for" apart from "tsc printed at least one diagnostic we cannot classify",
// which need different, honest outcomes (see classifyTscOutput below).
export const ANY_TS_DIAGNOSTIC_RE = /TS\d{4}/g;

/**
 * Classify one package's captured (ANSI-stripped) tsc output.
 *
 * Returns one of:
 *  - { kind: 'does-not-compile', count } — at least one `error TS####:` that
 *    is not an unused-locals code. The package doesn't compile standalone;
 *    that belongs to the typecheck lane, not here, but it must not silently
 *    drop out of the ratchet either.
 *  - { kind: 'unparseable' } — some text matching the generic `TS####` shape
 *    is not accounted for by either recognised pattern above. This must fire
 *    even when OTHER diagnostics in the SAME output parsed fine: a run with
 *    one recognised violation and one diagnostic this script cannot classify
 *    must not silently report just the recognised one (the mixed-output gap
 *    from the #2634 review — the original check only looked for this when
 *    the recognised count was zero).
 *  - { kind: 'no-diagnostics' } — non-zero exit, but no `TS####`-shaped text
 *    at all. tsc never ran, or died without reporting.
 *  - { kind: 'violations', count } — every `TS####` in the output is either
 *    an unused-locals diagnostic or (impossible here, see does-not-compile
 *    above) another error; count is the number of unused-locals diagnostics.
 */
export function classifyTscOutput(output) {
  const unusedCount = output.match(UNUSED_RE)?.length ?? 0;
  const otherErrorCount = output.match(OTHER_ERROR_RE)?.length ?? 0;
  const totalDiagnostics = output.match(ANY_TS_DIAGNOSTIC_RE)?.length ?? 0;

  if (otherErrorCount > 0) {
    return { kind: 'does-not-compile', count: unusedCount };
  }
  if (totalDiagnostics > unusedCount + otherErrorCount) {
    return { kind: 'unparseable' };
  }
  if (unusedCount === 0) {
    return { kind: 'no-diagnostics' };
  }
  return { kind: 'violations', count: unusedCount };
}
