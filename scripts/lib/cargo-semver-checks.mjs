/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ONE `cargo-semver-checks` run: how to ask, and what the answer means.
 *
 * Split out of `scripts/check-rust-semver.mjs` when the executed-lint floor
 * landed (#4786). The two halves are one invariant and had drifted apart while
 * they shared a file: how much the tool compares is decided by an ARGUMENT
 * (`--release-type`), and what its summary line is allowed to mean depends on
 * that same argument. Reading `Summary no semver update required` as "at most a
 * patch is required" is only sound because the run asked about a patch. Keeping
 * the argv here, beside the parse that depends on it, is the point of the
 * split, not a side effect of the line limit.
 *
 * Everything here is about the tool. What to DO with a verdict — which crates,
 * which baseline, which bump the version carries, and whether a crate may be
 * cleared — is release policy and stays in `check-rust-semver.mjs`.
 *
 * Tests live with the gate's, in `scripts/check-rust-semver.test.mjs`.
 */

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `rust-toolchain.toml` pins this workspace to a dated nightly, and
 * cargo-semver-checks refuses it outright ("rustc version is not high enough:
 * >=1.93.0 needed, got 1.93.0-nightly"). Left alone that produces no Summary
 * line, so the gate would fail with NO_VERDICT on every crate — fail-closed,
 * but for the wrong reason and with no way to act on it. So the toolchain is
 * named explicitly, and overridable for the day stable moves under us.
 */
export const SEMVER_TOOLCHAIN = process.env.IFC_LITE_SEMVER_TOOLCHAIN || 'stable';

/**
 * The release size `cargo-semver-checks` is told to assume, instead of letting
 * it infer one from the manifest version against the baseline (#4786).
 *
 * The tool only runs the lints that could refuse the release it thinks it is
 * being asked about, so the inferred level decides how much gets compared, and
 * a release that already carries a big bump is compared against nothing.
 * Measured on `ifc-lite-clash`, baseline the published 14.0.0, manifests at
 * 15.0.0, cargo-semver-checks 0.50.0:
 *
 *   inferred (no flag)      0 checks: 0 pass, 254 skip   "no semver update required"
 *   --release-type minor  196 checks: 196 pass, 58 skip  "no semver update required"
 *   --release-type patch  223 checks: 223 pass, 31 skip  "no semver update required"
 *
 * So `patch` and not `minor`: at `minor` the tool still skips the 27 lints that
 * only a minor could fail (a new `pub` item), and a minor-requiring change
 * would come back as `no semver update required` — which [[interpretRun]] reads
 * as `patch`, and the gate would then wave through under a patch release.
 * `patch` is the smallest release there is, so it selects every lint the tool
 * is prepared to fail on and the verdict returned is the true minimum the
 * change requires. Judging that against the bump the version actually carries
 * is the GATE's job (`RANK` in check-rust-semver.mjs), and it is the part that
 * was being handed to the tool and lost.
 *
 * NOT every lint, even so: 223 of 254, because the other 31 carry
 * `lint_level: Allow` in cargo-semver-checks' own lint definitions and are
 * dropped at EVERY release type. Nothing this gate passes reaches them. That is
 * why the floor downstream is on a count above zero and not on a count of 254.
 */
export const SEMVER_RELEASE_TYPE = 'patch';

/**
 * The exact argument list the gate runs. Exported so the one argument that
 * decides how much gets compared is pinned by a test rather than by reading
 * this function (#4786).
 */
export function semverChecksArgv(crate, baseline, { baselineRustdoc } = {}) {
  return [
    `+${SEMVER_TOOLCHAIN}`,
    'semver-checks',
    '--package',
    crate,
    // A rebuilt baseline (#7737, scripts/lib/semver-baseline.mjs) replaces
    // the registry lookup; the release type and everything else stay.
    ...(baselineRustdoc ? ['--baseline-rustdoc', baselineRustdoc] : ['--baseline-version', baseline]),
    // Not the bump the manifest happens to carry: see SEMVER_RELEASE_TYPE.
    '--release-type',
    SEMVER_RELEASE_TYPE,
    '--color',
    'never',
  ];
}

/** Run it. The unit tests inject a fake in place of this. */
export function runSemverChecks(crate, baseline, opts = {}) {
  const res = spawnSync('cargo', semverChecksArgv(crate, baseline, opts), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status ?? -1, output: `${res.stdout || ''}${res.stderr || ''}` };
}

/**
 * How many lints the run executed, from `cargo-semver-checks`' own tally line
 * (`Checked [ 0.598s] 223 checks: 223 pass, 31 skip`), or null when there is no
 * such line to read.
 *
 * The SKIPPED count is not the signal and must not be: a healthy run skips
 * lints every time (31 of 254 on this workspace at `--release-type patch`), so
 * a floor written against `skip` would refuse every real release. Only the
 * executed count separates a comparison that happened from one that did not.
 *
 * `N checks:` and not `N checks` — the colon is what keeps the summary line's
 * own "0 major and 1 minor checks failed" from being read as a tally.
 */
export function executedCheckCount(output) {
  const tally = output.match(/(\d+)\s+checks:/);
  return tally ? Number(tally[1]) : null;
}

const BUMP_RANK = { patch: 1, minor: 2, major: 3 };

/**
 * The bump a run's WARN-level lints suggest, or null when none fired.
 *
 * `Summary` is driven by the tool's `required_bumps`, which counts ERRORS
 * only. The 14 lints that carry `lint_level: Warn` feed a separate
 * `suggested_bumps` and print underneath a clean `Summary no semver update
 * required`, as their own `produced warnings suggest new <level> version`
 * line (check_release.rs:597 and :603-625 in 0.50.0). Measured against a real
 * repr(C) field reorder — cargo-semver-checks 0.50.0, `--release-type patch`
 * — the transcript is exactly:
 *
 *   Checked [   0.010s] 223 checks: 222 pass, 0 fail, 1 warn, 31 skip
 *   Summary no semver update required
 *   Warning produced 1 major and 0 minor level warnings
 *           produced warnings suggest new major version
 *
 * with exit code 0. This line, not the `Warning produced N major and M minor`
 * one above it, is read: it already names the bump, so there is no count
 * arithmetic to duplicate or get wrong here.
 */
function warnSuggests(output) {
  const suggest = output.match(/produced warnings suggest new (major|minor) version/);
  return suggest ? suggest[1] : null;
}

/**
 * The verdict of one run: the bump the tool says the API change requires, how
 * many lints it executed to say so, and a named reason when the output cannot
 * be read as a verdict at all.
 *
 * The exit code is NOT the signal: it is non-zero both for "this needs a major
 * and you wrote a minor" and for "rustdoc failed to build". Reading the second
 * as the first reports a semver break nobody can fix; reading it as a pass is
 * the vacuous green this gate exists to refuse. So the summary line must be
 * present and recognised, and anything else is NO_VERDICT, which fails.
 *
 * `executed` is reported rather than judged here. Whether a verdict backed by
 * zero lints may clear a crate is the gate's call, because "cleared" is decided
 * against the bump the version carries and this module does not know it
 * (#4786).
 *
 * `required` folds in what WARN-level lints suggest (#4800), taking whichever
 * of the error-driven Summary and the warn-driven suggestion is the LARGER
 * bump — never the smaller, so a warning can only raise the bar a failing
 * lint already set, not lower it. A run whose Summary reads clean but whose
 * warnings suggest a major — the `#[repr(C)]` field-reorder case that is
 * ifc-lite-ffi's own named hazard — now reports `major`, not `patch`.
 */
export function interpretRun({ status, output }) {
  const executed = executedCheckCount(output);
  const warnRequired = warnSuggests(output);
  const raise = (required) =>
    warnRequired && BUMP_RANK[warnRequired] > BUMP_RANK[required] ? warnRequired : required;
  if (/Summary\s+no semver update required/.test(output)) {
    return { required: raise('patch'), executed, reason: null };
  }
  const requires = output.match(/Summary\s+semver requires new (major|minor) version/);
  if (requires) return { required: raise(requires[1]), executed, reason: null };
  return {
    required: null,
    executed,
    reason:
      `NO_VERDICT: cargo-semver-checks exited ${status} without a "Summary" line — ` +
      'it could not build or compare the crate, so nothing was checked' +
      outputExcerpt(output),
  };
}

/**
 * What the tool said when it reached no verdict (#7737). The run's stdout and
 * stderr were captured and then dropped, so CI printed a bare `NO_VERDICT
 * exited 101` that could not be attributed to anything. The excerpt starts at
 * the first `error` line (cargo's resolver and build errors put the cause
 * there and the advice after it) and is capped, so a 10,000-line compile log
 * cannot bury the rest of the report.
 */
export function outputExcerpt(output, max = 40) {
  const lines = String(output ?? '').split('\n').map((l) => l.trimEnd()).filter(Boolean);
  if (lines.length === 0) return ' (it printed nothing)';
  const first = lines.findIndex((l) => /^\s*error\b/.test(l));
  const shown = first === -1 ? lines.slice(-max) : lines.slice(first, first + max);
  const cut = lines.length > shown.length ? `\n      | ... (${lines.length - shown.length} more line(s))` : '';
  return `. It printed:\n      | ${shown.map((l) => l.slice(0, 300)).join('\n      | ')}${cut}`;
}
