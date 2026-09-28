#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-rust-semver.mjs (issue #3216).
 *
 * The gate prints "every Rust API change fits <version>". That sentence is
 * equally true of a release whose crates really are compatible and of a run
 * that compared nothing — so every way it could go false-green is an
 * executable case here: no crates, a crate list that silently shrank, a crate
 * with no baseline on crates.io, a `cargo-semver-checks` run that produced no
 * verdict, an unreadable workspace version, and a run whose clean verdict was
 * reached over zero executed lints (#4786). Each must FAIL, and fail with its
 * own named reason.
 *
 * The expensive half (`cargo semver-checks`, minutes per crate, network for
 * the baseline) is injected, so the decision logic is tested at unit speed and
 * the real runner is exercised once by hand — see the PR for that transcript.
 * The one thing the injection cannot fake, `cargo semver-checks` being absent
 * from PATH, is covered by spawning the real CLI at the bottom of this file.
 *
 * Run: node --test scripts/check-rust-semver.test.mjs
 * (also picked up by the scripts/*.test.mjs glob catch-all in test.yml).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as rustSemver from './check-rust-semver.mjs';
const {
  readVersionOrNull,
  bumpLevel,
  isVersionAdvanced,
  checkRustSemver,
  CRATE_FLOOR,
  interpretRun,
  executedCheckCount,
  semverChecksArgv,
  loadPublishedBaselines,
} = rustSemver;
import { CRATES } from './lib/crates-io.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');

/** The real published list, so a case that is not about the crate list clears
 *  CRATE_FLOOR and stays honest about how many crates a release touches. */
const SEVEN = CRATES;

/** `cargo semver-checks` output for each verdict, copied from a real run. */
const COMPATIBLE = {
  status: 0,
  output: [
    '    Checking ifc-lite-clash v6.0.1 -> v6.0.2 (patch change)',
    '     Checked [   0.598s] 223 checks: 223 pass, 31 skip',
    '     Summary no semver update required',
    '    Finished [ 200.665s] ifc-lite-clash',
  ].join('\n'),
};
const NEEDS_MAJOR = {
  status: 1,
  output: [
    '--- failure method_parameter_count_changed: pub method parameter count changed ---',
    '  ifc_lite_clash::Aabb::inflate takes 1 parameters ..., but now takes 2 parameters ...',
    '     Checked [   0.007s] 223 checks: 222 pass, 1 fail, 0 warn, 31 skip',
    '     Summary semver requires new major version: 1 major and 0 minor checks failed',
    '    Finished [ 205.112s] ifc-lite-clash',
  ].join('\n'),
};
const NEEDS_MINOR = {
  status: 1,
  output: [
    '     Checked [   0.006s] 223 checks: 222 pass, 1 fail, 0 warn, 31 skip',
    '     Summary semver requires new minor version: 0 major and 1 minor checks failed',
  ].join('\n'),
};

/**
 * A run that executed NOTHING and exited 0 saying so (#4786). Transcribed from
 * the real thing: the gate's own argv on main at 15.0.0 against the published
 * 14.0.0, cargo-semver-checks 0.50.0, which infers a major, has nothing left to
 * refuse, skips its entire lint set and reports the same Summary line a healthy
 * comparison reports.
 */
const SKIPPED_EVERY_LINT = {
  status: 0,
  output: [
    '    Checking ifc-lite-clash v14.0.0 -> v15.0.0 (major change)',
    '     Checked [   0.000s] 0 checks: 0 pass, 254 skip',
    '     Summary no semver update required',
    '    Finished [   1.705s] ifc-lite-clash',
  ].join('\n'),
};

/**
 * A run that DETECTED a break but at warn level (#4800), so `required_bumps`
 * — which drives the `Summary` line — never sees it: only `suggested_bumps`
 * does, on the `Warning produced ...` / `produced warnings suggest ...` lines
 * beneath a clean Summary. Transcribed from a real run, cargo-semver-checks
 * 0.50.0, `--baseline-root` against a two-crate fixture with a `#[repr(C)]`
 * struct whose fields were reordered between versions — the exact hazard
 * check-rust-semver.mjs's own header names as ifc-lite-ffi's blind spot:
 *
 *   $ cargo +stable semver-checks --baseline-root ../old --release-type patch --color never
 *        Checked [   0.010s] 223 checks: 222 pass, 0 fail, 1 warn, 31 skip
 *   --- warning repr_c_plain_struct_fields_reordered: ... ---
 *        Summary no semver update required
 *        Warning produced 1 major and 0 minor level warnings
 *                produced warnings suggest new major version
 *       Finished [   1.346s] repro
 *   $ echo $?
 *   0
 */
const WARN_MAJOR = {
  status: 0,
  output: [
    '     Checked [   0.010s] 223 checks: 222 pass, 0 fail, 1 warn, 31 skip',
    '',
    '--- warning repr_c_plain_struct_fields_reordered: struct fields reordered in repr(C) struct ---',
    '',
    'Failed in:',
    '  Point.x moved from position 1 to 2, in src/lib.rs:4',
    '  Point.y moved from position 2 to 1, in src/lib.rs:3',
    '',
    '     Summary no semver update required',
    '     Warning produced 1 major and 0 minor level warnings',
    '             produced warnings suggest new major version',
    '    Finished [   1.346s] repro',
  ].join('\n'),
};

/** Same shape, a warn-level MINOR suggestion instead of a major one. */
const WARN_MINOR = {
  status: 0,
  output: [
    '     Checked [   0.010s] 223 checks: 222 pass, 0 fail, 1 warn, 31 skip',
    '     Summary no semver update required',
    '     Warning produced 0 major and 1 minor level warnings',
    '             produced warnings suggest new minor version',
    '    Finished [   1.346s] repro',
  ].join('\n'),
};

/** Defaults every case starts from: all seven crates published at 6.0.1. */
function run(overrides = {}) {
  return checkRustSemver({
    crates: SEVEN,
    workspaceVersion: '6.0.2',
    latestPublished: () => '6.0.1',
    runSemverChecks: () => COMPATIBLE,
    ...overrides,
  });
}

/* ------------------------------- the gap itself ------------------------------ */

test('RED: a breaking Rust change under a patch npm bump is refused', () => {
  const result = run({
    runSemverChecks: (crate) => (crate === 'ifc-lite-processing' ? NEEDS_MAJOR : COMPATIBLE),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /^ifc-lite-processing: /);
  assert.match(result.failures[0], /requires a MAJOR bump/);
  // The numbers must be in the message: a gate that says "semver violation"
  // without saying which version it compared against is not actionable.
  assert.match(result.failures[0], /6\.0\.1 -> 6\.0\.2/);
  assert.match(result.failures[0], /which is a patch/);
});

test('GREEN: a compatible change under the same patch bump passes', () => {
  const result = run();
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.checked.length, SEVEN.length);
});

test('GREEN: the same breaking change passes once the version carries a major', () => {
  const result = run({
    workspaceVersion: '7.0.0',
    runSemverChecks: (crate) => (crate === 'ifc-lite-processing' ? NEEDS_MAJOR : COMPATIBLE),
  });
  assert.equal(result.ok, true, result.failures.join('\n'));
});

test('a minor-requiring change is refused under a patch and allowed under a minor', () => {
  const under = run({ runSemverChecks: () => NEEDS_MINOR });
  assert.equal(under.ok, false);
  assert.match(under.failures[0], /requires a MINOR bump/);

  const over = run({ workspaceVersion: '6.1.0', runSemverChecks: () => NEEDS_MINOR });
  assert.equal(over.ok, true, over.failures.join('\n'));
});

test('every offending crate is named, not just the first', () => {
  const result = run({ runSemverChecks: () => NEEDS_MAJOR });
  assert.equal(result.failures.length, SEVEN.length);
  for (const crate of SEVEN) {
    assert.ok(
      result.failures.some((f) => f.startsWith(`${crate}:`)),
      `${crate} is missing from the failure list`
    );
  }
});

/* ------------------------------ vacuous passes ------------------------------ */

test('VACUITY: an empty crate list fails with NO_CRATES', () => {
  const result = run({ crates: [] });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /^NO_CRATES: /);
});

test('VACUITY: a crate list that could not be found fails with NO_CRATES', () => {
  const result = run({ crates: null });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /^NO_CRATES: /);
});

test('VACUITY: a crate list that silently shrank fails with CRATE_FLOOR', () => {
  const result = run({ crates: SEVEN.slice(0, 2) });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /^CRATE_FLOOR: found 2 crate\(s\)/);
  // The remedy must be stated, or someone whose scan is fine gets an actively
  // wrong instruction.
  assert.match(result.failures[0], /lower CRATE_FLOOR in the same commit/);
});

test('VACUITY: a crate with no crates.io baseline fails with NO_BASELINE', () => {
  const result = run({
    latestPublished: (crate) => (crate === 'ifc-lite-ffi' ? null : '6.0.1'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /^NO_BASELINE: ifc-lite-ffi /);
});

test('VACUITY: a registry lookup that fails for EVERY crate is not a pass', () => {
  const result = run({ latestPublished: () => null });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, SEVEN.length);
  assert.equal(result.checked.length, 0);
});

test('#6407: registry lookup failure stops baseline collection instead of becoming NO_BASELINE', async () => {
  const visited = [];
  await assert.rejects(
    () => loadPublishedBaselines(SEVEN, async (crate) => {
      visited.push(crate);
      if (crate === 'ifc-lite-ffi') throw new Error('crates.io returned 503');
      return '19.1.2';
    }),
    /REGISTRY_LOOKUP_FAILED: ifc-lite-ffi: crates\.io returned 503/
  );
  assert.deepEqual(visited, SEVEN.slice(0, SEVEN.indexOf('ifc-lite-ffi') + 1));

  const baselines = await loadPublishedBaselines(SEVEN, async () => '19.1.2');
  assert.equal(baselines.get('ifc-lite-ffi'), '19.1.2');
  assert.equal(baselines.size, SEVEN.length);

  await assert.rejects(
    () => loadPublishedBaselines(['ifc-lite-ffi'], async () => undefined),
    /REGISTRY_LOOKUP_FAILED: ifc-lite-ffi: registry returned no usable baseline answer/
  );
});

test('VACUITY: output with no Summary line fails with NO_VERDICT', () => {
  const unreadable = {
    status: 1,
    output: 'error: failed to build rustdoc for crate ifc-lite-clash v6.0.1',
  };
  const result = run({ runSemverChecks: () => unreadable });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, SEVEN.length);
  assert.match(result.failures[0], /NO_VERDICT: cargo-semver-checks exited 1/);
});

test('VACUITY: an empty run output is NO_VERDICT, never a pass', () => {
  const result = run({ runSemverChecks: () => ({ status: 0, output: '' }) });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /NO_VERDICT/);
});

test('VACUITY: a run that executed ZERO lints fails with NO_CHECKS_EXECUTED', () => {
  // #4786, the live case. The manifests carry 15.0.0 and crates.io carries
  // 14.0.0, so the carried bump is a `major` — RANK 3, which no `required`
  // verdict can exceed — and cargo-semver-checks, asked about a major, skips
  // all 254 lints and exits 0. Before this floor the gate printed
  // `ifc-lite-clash 14.0.0 -> 15.0.0 (major; requires patch)` for all seven
  // crates and called the release checked. Nothing had been compared.
  const result = run({
    workspaceVersion: '15.0.0',
    latestPublished: () => '14.0.0',
    runSemverChecks: () => SKIPPED_EVERY_LINT,
  });
  assert.equal(result.ok, false, 'a scan that examined nothing reported a pass');
  assert.equal(result.failures.length, SEVEN.length);
  for (const f of result.failures) assert.match(f, /NO_CHECKS_EXECUTED: /);
  assert.match(result.failures[0], /reported 0 executed lints/);
  // And the reassuring comparison line must not have been printed for any of
  // them: `checked` is what the success line counts.
  assert.deepEqual(result.checked, []);
});

test('the floor guards EVERY verdict that could clear a crate, not the clean-reading one', () => {
  // The axis matters. A crate is cleared when RANK[required] <= RANK[carried],
  // so under a carried major a `requires minor` verdict clears it exactly as a
  // `requires patch` does. A floor keyed on the summary line reading clean
  // would leave every verdict below the carried bump free to pass over a scan
  // that examined nothing.
  //
  // HARDENING, not a fixed live defect: cargo-semver-checks says a bump is
  // required only because a lint FAILED, so it is not known to produce this
  // combination. The gate refuses it anyway rather than resting on that.
  const minorOverNothing = {
    status: 1,
    output: [
      '     Checked [   0.000s] 0 checks: 0 pass, 254 skip',
      '     Summary semver requires new minor version: 0 major and 1 minor checks failed',
    ].join('\n'),
  };
  const result = run({
    workspaceVersion: '15.0.0',
    latestPublished: () => '14.0.0',
    runSemverChecks: () => minorOverNothing,
  });
  assert.equal(result.ok, false);
  for (const f of result.failures) assert.match(f, /NO_CHECKS_EXECUTED: /);
  assert.deepEqual(result.checked, []);
});

test('the floor is on EXECUTED lints, not on skipped ones', {
  skip: typeof executedCheckCount !== 'function',
}, () => {
  // A healthy run skips lints every time (31 of 254 at --release-type patch on
  // this workspace), so a floor written against `skip` would refuse every real
  // release. COMPATIBLE is a real 223-pass/31-skip transcript.
  assert.equal(executedCheckCount(COMPATIBLE.output), 223);
  assert.equal(executedCheckCount(SKIPPED_EVERY_LINT.output), 0);
  // The colon is the discriminator: the summary line's own "0 major and 1
  // minor checks failed" is not a tally.
  assert.equal(
    executedCheckCount('Summary semver requires new minor version: 0 major and 1 minor checks failed'),
    null
  );
});

test('a verdict with no tally line at all is NO_CHECKS_EXECUTED, not a pass', {
  skip: typeof interpretRun !== 'function',
}, () => {
  // If the tool's output format moves, the gate must not read the absence of
  // evidence as evidence that a comparison happened.
  const noTally = { status: 0, output: '     Summary no semver update required' };
  assert.equal(interpretRun(noTally).executed, null);

  const result = run({ runSemverChecks: () => noTally });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /NO_CHECKS_EXECUTED: /);
  assert.match(result.failures[0], /printed no "N checks:" tally/);
  // The remedy for a missing tally is not the remedy for a zero one, and the
  // message must not hand over the wrong one.
  assert.match(result.failures[0], /executedCheckCount/);
});

test('interpretRun reports the executed count as a fact and judges nothing', {
  skip: typeof interpretRun !== 'function',
}, () => {
  // The split the floor's placement rests on: reading the tally is the tool
  // adapter's job, deciding what a zero means is the gate's.
  assert.equal(interpretRun(COMPATIBLE).executed, 223);
  assert.equal(interpretRun(COMPATIBLE).reason, null);
  assert.equal(interpretRun(SKIPPED_EVERY_LINT).executed, 0);
  assert.equal(
    interpretRun(SKIPPED_EVERY_LINT).reason,
    null,
    'the adapter must not refuse on the gate’s behalf'
  );
  assert.equal(interpretRun(SKIPPED_EVERY_LINT).required, 'patch');
});

test('RED (#4800): a detected warn-level break is not discarded as patch', {
  skip: typeof interpretRun !== 'function',
}, () => {
  // Before the fix, interpretRun reads only the Summary line, which is driven
  // by required_bumps (errors only). WARN_MAJOR carries a full 223-lint tally
  // AND a real detected break — cargo-semver-checks' own
  // repr_c_plain_struct_fields_reordered lint, at warn level — so the
  // NO_CHECKS_EXECUTED floor from #4786 does not and cannot catch this: the
  // scan executed, and still returned a verdict that throws away what it
  // found. `required` must be `major`, not `patch`.
  assert.equal(
    interpretRun(WARN_MAJOR).required,
    'major',
    'a warn-level repr(C) field reorder was read as "patch", exactly the ' +
      'ifc-lite-ffi hazard check-rust-semver.mjs names as unclosed'
  );
  assert.equal(interpretRun(WARN_MINOR).required, 'minor');
  // The executed count and reason are untouched by folding the warning in.
  assert.equal(interpretRun(WARN_MAJOR).executed, 223);
  assert.equal(interpretRun(WARN_MAJOR).reason, null);
});

test('a warn-level suggestion never LOWERS a verdict an error already forced higher', {
  skip: typeof interpretRun !== 'function',
}, () => {
  // NEEDS_MAJOR already requires major from a failing lint; layering a
  // warn-level minor suggestion on top of it must not read as a downgrade.
  const majorErrorPlusMinorWarn = {
    status: 1,
    output:
      NEEDS_MAJOR.output +
      '\n     Warning produced 0 major and 1 minor level warnings\n' +
      '             produced warnings suggest new minor version',
  };
  assert.equal(interpretRun(majorErrorPlusMinorWarn).required, 'major');
});

test('a warn-level suggestion RAISES a verdict an error alone set lower', () => {
  // NEEDS_MINOR requires only minor from its failing lint; a warn-level
  // major suggestion on the same run must still win, in this branch too
  // (the error-verdict branch of interpretRun, not just the clean-Summary
  // one WARN_MAJOR exercises).
  const minorErrorPlusMajorWarn = {
    status: 1,
    output:
      NEEDS_MINOR.output +
      '\n     Warning produced 1 major and 0 minor level warnings\n' +
      '             produced warnings suggest new major version',
  };
  assert.equal(interpretRun(minorErrorPlusMajorWarn).required, 'major');
});

test('the run is forced to the smallest release type, so the lint set is selected', {
  skip: typeof semverChecksArgv !== 'function',
}, () => {
  // The other half of #4786. Letting cargo-semver-checks infer the release
  // size from the manifest version is what produced the zero-lint pass: it
  // only runs the lints that could refuse the release it thinks it is judging.
  // Measured on ifc-lite-clash against the published 14.0.0 with the manifests
  // at 15.0.0 (cargo-semver-checks 0.50.0):
  //   inferred      0 checks, 254 skip
  //   minor       196 checks,  58 skip   (the 27 minor lints still skipped)
  //   patch       223 checks,  31 skip
  // `patch` and not `minor`: at minor a minor-requiring change comes back as
  // "no semver update required", which interpretRun reads as `patch` and the
  // gate would then wave through under a patch release.
  const argv = semverChecksArgv('ifc-lite-clash', '14.0.0');
  const at = argv.indexOf('--release-type');
  assert.notEqual(at, -1, 'the gate lets cargo-semver-checks infer the release size again');
  assert.equal(argv[at + 1], 'patch');
  assert.deepEqual(argv.slice(1, 6), [
    'semver-checks',
    '--package',
    'ifc-lite-clash',
    '--baseline-version',
    '14.0.0',
  ]);
});

test('VACUITY: an unreadable workspace version fails with BAD_VERSION', () => {
  for (const version of [null, '', 'workspace-inherited']) {
    const result = checkRustSemver({
      crates: SEVEN,
      workspaceVersion: version,
      latestPublished: () => '6.0.1',
      runSemverChecks: () => COMPATIBLE,
    });
    assert.equal(result.ok, false, `version ${JSON.stringify(version)} passed`);
    assert.match(result.failures[0], /^BAD_VERSION: /);
  }
});

test('a crate already published at this exact version is reported, and NOT counted as compared', () => {
  // The release republishes none of them, so there is nothing to gate — but
  // the success line must not claim seven crates were compared when zero were.
  const result = run({ workspaceVersion: '6.0.1' });
  assert.equal(result.ok, true);
  assert.equal(result.checked.length, SEVEN.length);
  assert.equal(result.compared, 0);
  assert.match(result.checked[0], /already published at this version/);
});

test('the CLI never reports a compatibility result it did not compute', () => {
  // This test used to `return` before asserting whenever the CLI exited
  // non-zero or printed anything other than "nothing to gate" — which is
  // EVERY run on a machine without cargo-semver-checks, i.e. every CI runner
  // but release.yml's. It executed no assertion at all and still reported a
  // pass. It now classifies the outcome and asserts in each branch, and an
  // outcome it cannot classify is a failure rather than a silent skip.
  const res = spawnSync(process.execPath, [join(SCRIPTS, 'check-rust-semver.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, IFC_LITE_SEMVER_TOOLCHAIN: 'stable' },
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const CLAIMS_A_RESULT = /every Rust API change fits/;

  if (res.status === 2) {
    // cargo-semver-checks absent: refuse, and do not claim a result.
    assert.match(out, /TOOL_MISSING/);
    assert.doesNotMatch(out, CLAIMS_A_RESULT);
    return;
  }
  if (res.status === 0 && /nothing to gate/.test(out)) {
    assert.match(out, /No API was compared/);
    assert.doesNotMatch(out, CLAIMS_A_RESULT);
    return;
  }
  if (res.status === 0) {
    // A real comparison ran; the success line must say how many crates it
    // actually compared, not merely that something passed.
    assert.match(out, /\d+ of \d+ crate\(s\) compared against crates\.io/);
    return;
  }
  if (res.status === 1) {
    assert.match(out, /Rust crate semver gate failed/);
    return;
  }
  assert.fail(`the gate exited ${res.status} with output this test cannot classify:\n${out}`);
});

test('VACUITY: a release version BEHIND crates.io fails with VERSION_NOT_ADVANCED', () => {
  // The construction that showed `bumpLevel` is direction-blind: a baseline of
  // 7.0.0 against a release carrying 6.0.2 is reported as a `major`, the top
  // rank, so `RANK[required] > RANK[carried]` can never fire — all seven
  // crates requiring a major passed, printing `7.0.0 -> 6.0.2 (major;
  // requires major)`. HARDENING, not a fixed live defect: changesets never
  // walk a version backwards, and no route that reaches this is known.
  const result = run({
    workspaceVersion: '6.0.2',
    latestPublished: () => '7.0.0',
    runSemverChecks: () => NEEDS_MAJOR,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, SEVEN.length);
  for (const f of result.failures) assert.match(f, /^VERSION_NOT_ADVANCED: /);
  // And it must not have printed the reassuring comparison line for any of them.
  assert.deepEqual(
    result.checked.filter((line) => /7\.0\.0 -> 6\.0\.2/.test(line)),
    []
  );
});

test('VERSION_NOT_ADVANCED catches a single-component regression too', () => {
  const result = run({ workspaceVersion: '6.0.1', latestPublished: () => '6.0.2' });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /^VERSION_NOT_ADVANCED: /);
});

test('bumpLevel is direction-blind BY DESIGN; the direction is checked separately', () => {
  // Pinned so the two halves of the judgement stay separable: bumpLevel names
  // the component, isVersionAdvanced names the direction.
  assert.equal(bumpLevel('7.0.0', '6.0.2'), 'major');
  assert.equal(bumpLevel('6.0.2', '7.0.0'), 'major');
  assert.equal(isVersionAdvanced('7.0.0', '6.0.2'), false);
  assert.equal(isVersionAdvanced('6.0.2', '7.0.0'), true);
  assert.equal(isVersionAdvanced('6.0.1', '6.0.1'), false);
});

test('VACUITY: a baseline that is not a semver triple fails with BAD_BASELINE', () => {
  // Every comparison against it is NaN, and a NaN comparison reads as
  // "no change", which reads as a pass.
  const result = run({ latestPublished: () => '6.0.1-alpha.1' });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, SEVEN.length);
  assert.match(result.failures[0], /^BAD_BASELINE: /);
});

test('a mixed run counts only the crates actually compared', () => {
  const result = run({
    latestPublished: (crate) => (crate === SEVEN[0] ? '6.0.2' : '6.0.1'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.compared, SEVEN.length - 1);
});

/* ----------------------------- the pieces it parses ---------------------------- */

test('the crate list is the one the release actually publishes', () => {
  // Shared with release-crates.mjs and verify-crates-publish.js via
  // scripts/lib/crates-io.mjs (#3181) — imported, not re-typed, so a crate
  // added to the release cannot be missing from the gate.
  assert.ok(
    CRATES.length >= CRATE_FLOOR,
    `the release publishes ${CRATES.length} crates, below this gate's floor of ${CRATE_FLOOR}`
  );
  for (const crate of CRATES) {
    assert.match(crate, /^ifc-lite-/, `unexpected entry ${crate}`);
  }
});

test('every crate the gate would check exists under rust/', () => {
  const names = new Set();
  for (const dir of readdirSync(join(ROOT, 'rust'))) {
    const manifest = join(ROOT, 'rust', dir, 'Cargo.toml');
    if (!existsSync(manifest)) continue;
    const name = readFileSync(manifest, 'utf8').match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (name) names.add(name);
  }
  for (const crate of CRATES) {
    assert.ok(names.has(crate), `${crate} is published but has no manifest under rust/`);
  }
});

test('CRATE_FLOOR catches a crate list that shrank on the way in', () => {
  // Importing the list rules out a stale copy, not a filtered or truncated
  // one. Without the floor a six-crate list would report success over seven
  // crates' worth of release.
  const result = run({ crates: CRATES.slice(0, CRATES.length - 1) });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /^CRATE_FLOOR/);
});

test('the workspace version is read from the real Cargo.toml', () => {
  assert.match(readVersionOrNull(ROOT), /^\d+\.\d+\.\d+$/);
});

test('a missing or non-semver workspace version reads as absent, not as a version', () => {
  // readWorkspaceVersion throws on a Cargo.toml with no [workspace.package]
  // version, and returns the raw string when it is not a semver triple.
  // Neither may reach the comparison.
  const dir = mkdtempSync(join(tmpdir(), 'rust-semver-'));
  try {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nversion = "1.2.3"\n');
    assert.equal(readVersionOrNull(dir), null);
    writeFileSync(join(dir, 'Cargo.toml'), '[workspace.package]\nversion = "nightly"\n');
    assert.equal(readVersionOrNull(dir), null);
    writeFileSync(join(dir, 'Cargo.toml'), '[workspace.package]\nversion = "1.2.3"\n');
    assert.equal(readVersionOrNull(dir), '1.2.3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bumpLevel names the bump the version carries', () => {
  assert.equal(bumpLevel('6.0.1', '7.0.0'), 'major');
  assert.equal(bumpLevel('6.0.1', '6.1.0'), 'minor');
  assert.equal(bumpLevel('6.0.1', '6.0.2'), 'patch');
  assert.equal(bumpLevel('6.0.1', '6.0.1'), 'none');
  // A major bump that also moves the minor is still a major, not a minor.
  assert.equal(bumpLevel('6.0.1', '7.2.0'), 'major');
});

test('interpretRun reads the three verdicts and refuses anything else', () => {
  assert.equal(interpretRun(COMPATIBLE).required, 'patch');
  assert.equal(interpretRun(NEEDS_MINOR).required, 'minor');
  assert.equal(interpretRun(NEEDS_MAJOR).required, 'major');
  // A zero exit code with no summary is still no verdict: the exit code is not
  // the signal.
  assert.match(interpretRun({ status: 0, output: 'Finished' }).reason, /NO_VERDICT/);
});

/* -------------------------------- the wiring -------------------------------- */

test('the gate is wired as the crates.io half’s precondition, and only that half', () => {
  // A gate nothing runs is the same as no gate. It must also NOT gate npm: the
  // npm bump is not what is wrong, and release-all.mjs exists precisely to stop
  // one registry being held hostage by the other.
  const releaseAll = readFileSync(join(SCRIPTS, 'release-all.mjs'), 'utf8');
  const steps = [...releaseAll.matchAll(/\{\s*name: '([^']+)'[^}]*\}/g)].map((m) => m[0]);
  assert.ok(steps.length >= 2, 'release-all.mjs no longer declares a STEPS list this test can read');

  const crates = steps.find((s) => s.includes("name: 'crates.io'"));
  assert.ok(crates, 'release-all.mjs no longer has a crates.io step');
  assert.match(crates, /precondition: 'check:rust-semver'/);

  const npm = steps.find((s) => s.includes("name: 'npm'"));
  assert.ok(npm, 'release-all.mjs no longer has an npm step');
  assert.ok(!npm.includes('precondition'), 'the npm half must not be gated on the Rust semver check');

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check:rust-semver'], 'node scripts/check-rust-semver.mjs');
});

test('the release workflow installs what the gate needs', () => {
  // The gate fails closed when cargo-semver-checks is missing (TOOL_MISSING),
  // so a workflow that forgot to install it would block every release rather
  // than pass vacuously — loud, but still a release nobody can ship.
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /taiki-e\/install-action@[0-9a-f]{40} # cargo-semver-checks/);
  assert.match(workflow, /Install stable Rust for the crate semver gate/);
});

test('the gate runs on PRs, not only at release time', () => {
  // A release-only gate is the shape release-crates-order.test.mjs argues
  // against in its own header: the Release workflow runs only on main, and
  // only on an actual publish, so a breaking change sits latent until it fails
  // after npm has already gone out.
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
  assert.match(workflow, /run: node scripts\/check-rust-semver\.mjs/);
  assert.match(workflow, /taiki-e\/install-action@[0-9a-f]{40} # cargo-semver-checks/);
  // …and it must be one of the jobs the required check actually gates on. A
  // job nobody depends on is a job whose red is invisible.
  assert.match(workflow, /needs: \[[^\]]*\brust-semver\b[^\]]*\]/);
  assert.match(workflow, /\[rust-semver\]="\$\{\{ needs\.rust-semver\.result \}\}"/);
});

/* ------------------------------- the real CLI ------------------------------- */

test('VACUITY: the CLI fails with TOOL_MISSING when cargo-semver-checks is absent', () => {
  // Everything else is injectable; this is not. Run the real entry point with a
  // PATH that has no `cargo` on it, and assert it refuses rather than skips.
  const res = spawnSync(process.execPath, [join(SCRIPTS, 'check-rust-semver.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: join(SCRIPTS, 'no-such-directory-for-path') + delimiter },
  });
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}\n${res.stdout}${res.stderr}`);
  assert.match(res.stderr, /TOOL_MISSING/);
  assert.match(res.stderr, /fails rather than\s+skips/);
});
