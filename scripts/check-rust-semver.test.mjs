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
 * verdict, and an unreadable workspace version. Each must FAIL, and fail with
 * its own named reason.
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
import {
  readVersionOrNull,
  bumpLevel,
  interpretRun,
  isVersionAdvanced,
  checkRustSemver,
  CRATE_FLOOR,
} from './check-rust-semver.mjs';
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
  output: '     Summary semver requires new minor version: 0 major and 1 minor checks failed',
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
