/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const runner = fileURLToPath(new URL('./ci-rust-metrics.mjs', import.meta.url));

// #10279: real Cargo, without network/dependencies. This checks execution,
// freshness and failure propagation, rather than a mock's recorded argv.
test('CI metrics preserve feature inventory, filters, compile/test/doc failures and warm reuse (#10279)', t => {
  const tool = spawnSync('cargo', ['--version'], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: '0' } });
  if (tool.status !== 0) {
    t.skip('Cargo unavailable; run this fixture with the pinned Rust toolchain');
    return;
  }
  // Resolve in the repository, before the fixture leaves rust-toolchain.toml's ancestry.
  const active = spawnSync('rustup', ['show', 'active-toolchain'], {
    encoding: 'utf8', env: { ...process.env, RUSTUP_AUTO_INSTALL: '0' }, timeout: 10000,
  });
  assert.equal(active.status, 0, active.stderr);
  const toolchain = active.stdout.trim().split(/\s+/)[0];
  assert.ok(toolchain);
  const root = mkdtempSync(join(tmpdir(), 'rust-ci-metrics-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'Cargo.toml'), `[package]
name = "ci-metrics-fixture"
version = "0.0.0"
edition = "2021"
[workspace]
[features]
default = ["default-on"]
default-on = []
gate-a = []
gate-b = []
compile-failure = []
test-failure = []
doc-failure = []
`);
    writeFileSync(join(root, 'src/lib.rs'), `
#[cfg(feature = "compile-failure")]
compile_error!("intentional compiler failure");
/// \`\`\`
/// #[cfg(feature = "doc-failure")]
/// panic!("intentional doctest failure");
/// \`\`\`
pub fn documented() {}
#[test]
fn passes() { assert_eq!(2 + 2, 4); }
#[test]
fn feature_contract() {
    let enabled = [
        ("default-on", cfg!(feature = "default-on")),
        ("doc-failure", cfg!(feature = "doc-failure")),
        ("gate-a", cfg!(feature = "gate-a")),
        ("gate-b", cfg!(feature = "gate-b")),
        ("test-failure", cfg!(feature = "test-failure")),
    ].into_iter().filter_map(|(name, enabled)| enabled.then_some(name)).collect::<Vec<_>>();
    assert_eq!(enabled.join(","), std::env::var("EXPECTED_FEATURES").unwrap());
    assert!(!std::hint::black_box(cfg!(feature = "test-failure")), "intentional harness failure");
}
#[cfg(all(feature = "gate-a", feature = "gate-b"))]
#[test]
fn combined_configuration() { assert!(std::hint::black_box(cfg!(feature = "gate-a"))); }
`);
    const metrics = join(root, 'metrics.jsonl');
    const run = args => {
      const featureIndex = args.indexOf('--features');
      const expected = [...(args.includes('--no-default-features') ? [] : ['default-on']),
        ...(featureIndex < 0 ? [] : args[featureIndex + 1].split(','))].sort().join(',');
      const r = spawnSync(process.execPath, [runner, 'fixture', ...args], {
        cwd: root, encoding: 'utf8', timeout: 60000,
        env: { ...process.env, RUSTUP_AUTO_INSTALL: '0', RUSTUP_TOOLCHAIN: toolchain, CARGO_TARGET_DIR: join(root, 'target'),
          RUST_CI_METRICS: metrics, RUST_CI_CACHE_HIT: 'false', EXPECTED_FEATURES: expected,
          GITHUB_STEP_SUMMARY: join(root, 'summary.md') },
      });
      assert.ifError(r.error);
      const rows = readFileSync(metrics, 'utf8').trim().split('\n').map(JSON.parse);
      return { ...r, rows };
    };
    const cold = run(['test', '--offline']);
    assert.equal(cold.status, 0, cold.stderr);
    assert.ok(cold.rows[0].rebuiltArtifacts > 0);
    // @source-text-assertion-ok runtime process output or generated metrics, never source text
    assert.match(cold.stdout + cold.stderr, /Doc-tests/);
    const warm = run(['test', '--offline']);
    assert.equal(warm.status, 0, warm.stderr);
    assert.equal(warm.rows.at(-2).rebuiltArtifacts, 0);
    assert.ok(warm.rows.at(-2).freshArtifacts > 0);
    assert.equal(warm.rows.at(-2).artifactReuseRatio, 1);
    // Archive misses can still have 100% artifact reuse on a warm target.
    assert.equal(warm.rows.at(-2).cache, 'false');
    for (const features of ['gate-a', 'gate-b', 'gate-a,gate-b']) {
      const r = run(['test', '--offline', '--no-default-features', '--features', features]);
      assert.equal(r.status, 0, r.stderr);
      // @source-text-assertion-ok runtime process output or generated metrics, never source text
      if (features.includes(',')) assert.match(r.stdout, /combined_configuration \.\.\. ok/);
    }
    const filtered = run(['test', '--offline', '--features', 'test-failure', 'passes', '--', '--exact']);
    assert.equal(filtered.status, 0, filtered.stderr);
    // @source-text-assertion-ok runtime process output or generated metrics, never source text
    assert.match(filtered.stdout, /1 filtered out/);
    const failure = run(['test', '--offline', '--features', 'test-failure', '--no-fail-fast']);
    assert.notEqual(failure.status, 0);
    assert.equal(failure.rows.at(-1).phase, 'execute-with-cargo-and-doctests');
    assert.equal(failure.rows.at(-1).exitCode, failure.status);
    const doc = run(['test', '--offline', '--features', 'doc-failure']);
    assert.notEqual(doc.status, 0);
    // @source-text-assertion-ok runtime process output or generated metrics, never source text
    assert.match(doc.stdout + doc.stderr, /intentional doctest failure/);
    const compile = run(['test', '--offline', '--features', 'compile-failure']);
    assert.notEqual(compile.status, 0);
    assert.equal(compile.rows.at(-1).phase, 'compile');
    // @source-text-assertion-ok runtime process output or generated metrics, never source text
    assert.match(compile.stderr, /intentional compiler failure/);
    const clippy = run(['clippy', '--offline', '--all-targets', '--', '-D', 'warnings']);
    assert.equal(clippy.status, 0, clippy.stderr);
    assert.equal(clippy.rows.at(-1).phase, 'clippy');
    assert.ok(clippy.rows.every(row => row.seconds >= 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('command totals preserve failures, environment and report files (#10279)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rust-ci-command-'));
  try {
    const metrics = join(root, 'metrics.jsonl');
    const report = join(root, 'report.xml');
    const child = spawnSync(process.execPath, [runner, 'report', 'command', process.execPath, '-e',
      'require("node:fs").writeFileSync(process.env.REPORT_FILE, "<testsuite/>"); console.log("report ran"); process.exit(23)'], {
      encoding: 'utf8', env: { ...process.env, RUST_CI_METRICS: metrics, REPORT_FILE: report },
    });
    assert.equal(child.status, 23);
    assert.match(child.stdout, /report ran/);
    assert.equal(readFileSync(report, 'utf8'), '<testsuite/>');
    const [row] = readFileSync(metrics, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(row.phase, 'command-total');
    assert.equal(row.exitCode, 23);
    assert.equal(row.freshArtifacts, undefined);
    const missing = spawnSync(process.execPath, [runner, 'missing', 'command', join(root, 'absent')], {
      encoding: 'utf8', env: { ...process.env, RUST_CI_METRICS: metrics },
    });
    assert.notEqual(missing.status, 0);
    const last = readFileSync(metrics, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    // @source-text-assertion-ok runtime process output or generated metrics, never source text
    assert.match(last.error, /ENOENT/);
    assert.equal(last.exitCode, missing.status);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The workflow's machine-readable command inventory is the compatibility contract.
test('each retained and CSG command has a distinct summary identity (#10279)', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8'));
  for (const job of ['rust-retained', 'csg-accept-gates']) {
    const identities = new Set();
    let commands = 0;
    for (const step of workflow.jobs[job].steps) {
      for (const line of (step.run || '').split('\n')) {
        const match = /node scripts\/ci-rust-metrics\.mjs (\S+) (test|clippy|command) /.exec(line);
        if (!match) continue;
        const identity = `${match[1]} / ${match[2]}`;
        assert.equal(identities.has(identity), false, `ambiguous summary identity: ${identity}`);
        identities.add(identity);
        commands++;
      }
    }
    assert.equal(commands, job === 'rust-retained' ? 17 : 6);
  }
});
