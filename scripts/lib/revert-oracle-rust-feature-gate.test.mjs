/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * End-to-end proof, real Cargo, that the complete oracle sees a Rust test
 * gated behind a Cargo feature — the #4050/#4024 gap: `cargoRunner()` used to
 * hardcode a default-features `cargo test`, so a `#[cfg(feature = "x")]`
 * test compiled OUT and both the baseline and reverted runs collected the
 * same test count, reading as UNOBSERVED for a change that was never even
 * compiled in. Both directions are proven against the same fixture shape
 * #4024 actually uses: an item-level `#[cfg(any(feature = "gate_a", feature
 * = "gate_b"))]` immediately above `#[test]`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const oracle = resolve(dirname(fileURLToPath(import.meta.url)), '../check-test-revert-oracle.mjs');

function runOnce(gatedAssertsChange) {
  const root = mkdtempSync(join(tmpdir(), 'oracle-rust-feature-gate-'));
  const env = { ...process.env, CARGO_TARGET_DIR: join(root, 'target') };
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  function run(bin, args) {
    const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.error, undefined, `${bin}: ${result.error?.message}`);
    assert.equal(result.status, 0, `${bin} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }
  try {
    run('cargo', ['--version']);
    run('git', ['init', '-q']);
    run('git', ['config', 'user.name', 'Revert oracle fixture']);
    run('git', ['config', 'user.email', 'oracle@example.invalid']);
    // Base: the crate as it exists before this branch — no gated test yet, at all.
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, '.gitignore'), '/target/\n');
    writeFileSync(
      join(root, 'Cargo.toml'),
      '[package]\nname = "oracle-rust-feature-gate"\nversion = "0.1.0"\nedition = "2021"\n\n' +
        '[features]\ndefault = []\ngate_a = []\ngate_b = []\n',
    );
    writeFileSync(join(root, 'src/lib.rs'), 'pub mod value;\n');
    writeFileSync(join(root, 'src/value.rs'), 'pub fn value() -> u32 { 1 }\n');
    run('cargo', ['generate-lockfile', '--offline']);
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'control']);
    const base = run('git', ['rev-parse', 'HEAD']).trim();
    // Head: the branch's own diff — production changes AND, exactly like
    // #4024's chain_cycle_tests.rs, a NEW test file, item-level cfg-gated.
    mkdirSync(join(root, 'tests'));
    const gatedBody = gatedAssertsChange
      ? 'assert_eq!(oracle_rust_feature_gate::value::value(), 2);' // genuinely reverts to RED with production
      : 'assert!(true);'; // never touches the production value at all
    writeFileSync(
      join(root, 'tests/gated.rs'),
      ['#[cfg(any(feature = "gate_a", feature = "gate_b"))]', '#[test]', `fn gated_test() { ${gatedBody} }`, ''].join('\n'),
    );
    writeFileSync(join(root, 'src/value.rs'), 'pub fn value() -> u32 { 2 }\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'change production and add the feature-gated test']);
    const result = spawnSync(
      process.execPath,
      [oracle, '--root', root, '--base', base, '--ci', '--json'],
      { encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(result.status === 0 || result.status === 1, true, `unexpected exit ${result.status}\n${result.stdout}\n${result.stderr}`);
    return { stdout: result.stdout, status: result.status };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  '#4024 shape, OBSERVED direction: a feature-gated test that DOES assert on the changed production value flips RED on revert',
  { timeout: 120_000 },
  () => {
    const { stdout, status } = runOnce(true);
    assert.equal(status, 0, stdout);
    assert.match(stdout, /OBSERVED/);
    assert.match(stdout, /--features gate_a/);
    assert.match(stdout, /--features gate_b/);
    // Both plans together collected 2 tests, not 0 — the gated test actually
    // compiled in and ran; a silently-vacuous plan would read as "0 collected".
    assert.match(stdout, /2 collected/);
  },
);

test(
  '#4024 shape, UNOBSERVED direction: a feature-gated test compiled IN but asserting nothing about the change stays green',
  { timeout: 120_000 },
  () => {
    const { stdout, status } = runOnce(false);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /UNOBSERVED/);
  },
);
