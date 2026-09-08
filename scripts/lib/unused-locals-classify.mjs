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

/**
 * Matches the HEADER of one tsc diagnostic, and nothing else.
 *
 * Under `--pretty false` tsc prints exactly one diagnostic per line, opening
 * with an optional `file(line,col): ` location prefix, then a severity word,
 * then the code: `src/a.ts(2,9): error TS6133: …`, or bare `error TS5083: …`
 * for config/global diagnostics that have no file. Anchoring at `^` (with
 * `m`) and taking the first severity word on the line means at most one match
 * per line — the header — so text *inside* a message can never be read as a
 * second diagnostic.
 *
 * That distinction is the whole point (PR #2663 review). The previous generic
 * scan was a bare `/TS\d{4}/g` over the raw output, which counted any
 * `TS####` sequence anywhere: `error TS6133: 'TS1234' is declared but its
 * value is never read.` — verbatim tsc 6.0.3 output for an unused identifier
 * named `TS1234` — scored two "diagnostics" against one recognised
 * violation, so classifyTscOutput declared its own parsing broken and failed
 * the gate over output it had in fact parsed correctly. A file path
 * containing a code (`src/TS1234.ts`) did the same.
 *
 * `severity` is captured as well as the code because a diagnostic that is not
 * an `error` is one this script cannot classify, and must therefore still
 * reach the fail-loud branch rather than be quietly dropped.
 */
const DIAGNOSTIC_HEADER_RE = /^[^\n]*?(error|warning|message) TS(\d+):/gm;

/**
 * Tokenise tsc's output into the diagnostics it actually printed, one per
 * header. Every count classifyTscOutput branches on is derived from this ONE
 * scan, so "is this a diagnostic at all" and "which kind is it" cannot
 * disagree about where a diagnostic starts.
 *
 * @param {string} output ANSI-stripped tsc output.
 * @returns {{ total: number, unused: number, otherError: number }}
 */
function countDiagnostics(output) {
  let total = 0;
  let unused = 0;
  let otherError = 0;
  for (const [, severity, code] of output.matchAll(DIAGNOSTIC_HEADER_RE)) {
    total++;
    if (severity !== 'error') continue;
    if (UNUSED_CODES.includes(Number(code))) unused++;
    else otherError++;
  }
  return { total, unused, otherError };
}

/**
 * Classify one package's captured (ANSI-stripped) tsc output.
 *
 * Returns one of:
 *  - { kind: 'does-not-compile', count } — at least one `error TS####:` that
 *    is not an unused-locals code. The package doesn't compile standalone;
 *    that belongs to the typecheck lane, not here, but it must not silently
 *    drop out of the ratchet either.
 *  - { kind: 'unparseable' } — at least one diagnostic header (see
 *    DIAGNOSTIC_HEADER_RE) is not accounted for by either recognised kind:
 *    a non-`error` severity, or an `error` whose code the branching above
 *    doesn't reach. This must fire even when OTHER diagnostics in the SAME
 *    output parsed fine: a run with one recognised violation and one
 *    diagnostic this script cannot classify must not silently report just
 *    the recognised one (the mixed-output gap from the #2634 review — the
 *    original check only looked for this when the recognised count was zero).
 *  - { kind: 'no-diagnostics' } — non-zero exit, but no diagnostic header at
 *    all: tsc returned non-zero without reporting a diagnostic. (A run
 *    that was killed or truncated never reaches here — see
 *    untrustworthyExitReason below, which the caller applies first.)
 *  - { kind: 'violations', count } — every diagnostic in the output is either
 *    an unused-locals diagnostic or (impossible here, see does-not-compile
 *    above) another error; count is the number of unused-locals diagnostics.
 */
export function classifyTscOutput(output) {
  const { total: totalDiagnostics, unused: unusedCount, otherError: otherErrorCount } =
    countDiagnostics(output);

  // Unparseable is checked FIRST, ahead of does-not-compile: an unrecognised
  // diagnostic sitting alongside a genuine compile error is just as much a
  // parsing failure as one sitting alongside a recognised violation, and
  // folding it into "this package doesn't compile" would report a number this
  // script cannot actually stand behind. Any leftover diagnostic header fails
  // loud, whatever else matched.
  if (totalDiagnostics > unusedCount + otherErrorCount) {
    return { kind: 'unparseable' };
  }
  if (otherErrorCount > 0) {
    return { kind: 'does-not-compile', count: unusedCount };
  }
  if (unusedCount === 0) {
    return { kind: 'no-diagnostics' };
  }
  return { kind: 'violations', count: unusedCount };
}

/**
 * Vet the child process's *exit* before its output is classified.
 *
 * classifyTscOutput above only ever sees text, and a TRUNCATED run's text is a
 * prefix of well-formed diagnostics — which parses perfectly and returns a
 * confident, wrong, low count. Reproduced for the #2663 review: a child
 * emitting 5000 unused-locals diagnostics against a small maxBuffer came back
 * as `{ kind: 'violations', count: 97 }`, with `err.code === 'ENOBUFS'` sitting
 * unread on the error object. Under `--update` that undercount is written into
 * the baseline, permanently lowering the bar for every future run — the exact
 * failure mode the ratchet exists to prevent, reached from the other side.
 *
 * The only exit this check can stand behind is tsc running to completion and
 * reporting: a numeric exit status with no signal and no spawn-level error
 * code. Node populates the alternatives distinctly (verified against Node 22):
 *   - normal diagnostics: `{ status: 1, signal: null }`, no `code`
 *   - maxBuffer overflow: `{ code: 'ENOBUFS', status: null, signal: 'SIGTERM' }`
 *   - OOM / external kill: `{ status: null, signal: 'SIGKILL' }`
 *   - binary not found:   `{ code: 'ENOENT', status: null, signal: null }`
 *
 * @param {{ code?: string, status?: number|null, signal?: string|null }} err
 * @returns {string|null} null when the exit is trustworthy, else a short
 *   human-readable reason naming the code/signal for the failure message.
 */
export function untrustworthyExitReason(err) {
  if (err?.code != null) {
    return `the spawn failed with ${err.code}${err.signal ? ` (signal ${err.signal})` : ''}`;
  }
  if (err?.signal != null) {
    return `the process was killed by ${err.signal}`;
  }
  if (typeof err?.status !== 'number') {
    return 'the process exited without a status code';
  }
  return null;
}
