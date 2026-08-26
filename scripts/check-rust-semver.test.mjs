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
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCrateList,
  parseWorkspaceVersion,
  bumpLevel,
  interpretRun,
  checkRustSemver,
  CRATE_FLOOR,
} from './check-rust-semver.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');

/** Seven names, so a case that is not about the crate list clears CRATE_FLOOR. */
const SEVEN = [
  'ifc-lite-core',
  'ifc-lite-clash',
  'ifc-lite-geometry',
  'ifc-lite-processing',
  'ifc-lite-export',
  'ifc-lite-ffi',
  'ifc-lite-wasm',
];

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

test('a crate already published at this exact version is counted, not skipped silently', () => {
  const result = run({ workspaceVersion: '6.0.1' });
  assert.equal(result.ok, true);
  assert.equal(result.checked.length, SEVEN.length);
  assert.match(result.checked[0], /already published at this version/);
});

/* ----------------------------- the pieces it parses ---------------------------- */

test('the crate list is read from the real release-crates.mjs', () => {
  const crates = parseCrateList(readFileSync(join(SCRIPTS, 'release-crates.mjs'), 'utf8'));
  assert.notEqual(crates, null, 'release-crates.mjs no longer declares a CRATES array');
  assert.ok(
    crates.length >= CRATE_FLOOR,
    `parsed ${crates.length} crates, below the floor of ${CRATE_FLOOR}`
  );
  for (const crate of crates) {
    assert.match(crate, /^ifc-lite-/, `unexpected entry ${crate}`);
  }
});

test('every crate the gate would check exists under rust/', () => {
  const crates = parseCrateList(readFileSync(join(SCRIPTS, 'release-crates.mjs'), 'utf8'));
  const names = new Set();
  for (const dir of ['core', 'clash', 'geometry', 'processing', 'export', 'ffi', 'wasm-bindings']) {
    const manifest = join(ROOT, 'rust', dir, 'Cargo.toml');
    if (!existsSync(manifest)) continue;
    const name = readFileSync(manifest, 'utf8').match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (name) names.add(name);
  }
  for (const crate of crates) {
    assert.ok(names.has(crate), `${crate} is in CRATES but has no manifest under rust/`);
  }
});

test('the crate list is null, never [], when the array cannot be found', () => {
  assert.equal(parseCrateList('const OTHER = ["ifc-lite-core"];'), null);
});

test('CRATE_FLOOR catches a CRATES entry the parser cannot see', () => {
  // One entry rewritten with double quotes: the parser drops it silently, and
  // without the floor the gate would check six crates and report success.
  const mangled =
    'const CRATES = [\n' +
    SEVEN.map((c, i) => (i === 0 ? `  "${c}",` : `  '${c}',`)).join('\n') +
    '\n];';
  const crates = parseCrateList(mangled);
  assert.equal(crates.length, SEVEN.length - 1);
  const result = run({ crates });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /^CRATE_FLOOR/);
});

test('the workspace version is read from the real Cargo.toml', () => {
  const version = parseWorkspaceVersion(readFileSync(join(ROOT, 'Cargo.toml'), 'utf8'));
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('a non-semver workspace version reads as absent, not as a version', () => {
  assert.equal(parseWorkspaceVersion('[workspace.package]\nversion = "nightly"\n'), null);
  assert.equal(parseWorkspaceVersion('[package]\nversion = "1.2.3"\n'), null);
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
