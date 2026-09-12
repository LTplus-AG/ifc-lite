/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const oracle = resolve(dirname(fileURLToPath(import.meta.url)), '../check-test-revert-oracle.mjs');

test('#4016: the complete oracle executes changed Rust sibling assertions and restores production', { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-rust-siblings-'));
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
    // Real Cargo, no fake runner or handwritten output. No external crate deps.
    run('cargo', ['--version']);
    run('git', ['init', '-q']);
    run('git', ['config', 'user.name', 'Revert oracle fixture']);
    run('git', ['config', 'user.email', 'oracle@example.invalid']);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, '.gitignore'), '/target/\n');
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "oracle-rust-siblings"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, 'src/lib.rs'), 'pub mod value;\n#[cfg(test)] mod value_tests;\n#[cfg(test)] mod tests;\n#[cfg(test)]\n#[path = "renamed_tests.rs"]\nmod path_owned;\n');
    // A later Cargo target must still execute after the library target fails.
    // Its supported-version invariant holds for both production revisions.
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests/later_target.rs'),
      '#[test]\nfn version_stays_supported() { assert!((1..=2).contains(&oracle_rust_siblings::value::value())); }\n');
    const writeVersion = (value) => {
      // This unrelated nested `tests` module is intentionally always red. A
      // leaf-only `tests::` selector falsely credits/runs it while measuring
      // the top-level `src/tests.rs`; the full module path must exclude it.
      writeFileSync(join(root, 'src/value.rs'), `pub fn value() -> u32 { ${value} }\n#[cfg(test)] mod tests { #[test] fn must_not_run() { panic!("unrelated nested test"); } }\n`);
      for (const file of ['value_tests.rs', 'tests.rs', 'renamed_tests.rs']) {
        writeFileSync(join(root, 'src', file), `#[test]\nfn observes_value() { assert_eq!(crate::value::value(), ${value}); }\n`);
      }
    };
    writeVersion(1);
    // Generate/commit the lock before oracle's clean-tree check.
    run('cargo', ['generate-lockfile', '--offline']);
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'control']);
    const base = run('git', ['rev-parse', 'HEAD']).trim();
    writeVersion(2);
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'change production and both sibling assertions']);
    const output = run(process.execPath, [oracle, '--root', root, '--base', base, '--ci', '--json']);
    assert.match(output, /OBSERVED/);
    assert.match(output, /reverting production turned an assertion RED in src\/(?:renamed_tests|value_tests)\.rs/);
    assert.match(readFileSync(join(root, 'src/value.rs'), 'utf8'), /^pub fn value\(\) -> u32 \{ 2 \}/);
    assert.equal(run('git', ['status', '--porcelain']).trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#4109: a cfg-disabled path alias cannot borrow an active module test identity', { timeout: 60_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-rust-cfg-owner-'));
  const env = { ...process.env, CARGO_TARGET_DIR: join(root, 'target') };
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  const run = (bin, args, expected = 0) => {
    const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 50_000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.error, undefined, `${bin}: ${result.error?.message}`);
    assert.equal(result.status, expected, `${bin} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout + result.stderr;
  };
  try {
    run('git', ['init', '-q']);
    run('git', ['config', 'user.name', 'Revert oracle fixture']);
    run('git', ['config', 'user.email', 'oracle@example.invalid']);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, '.gitignore'), '/target/\n');
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="cfg-owner"\nversion="0.1.0"\nedition="2021"\n');
    writeFileSync(join(root, 'src/lib.rs'), 'pub fn value() -> u32 { 1 }\n#[cfg(any())]\n#[path="renamed_tests.rs"]\nmod tests;\n#[cfg(test)]\n#[path="active.rs"]\nmod tests;\n');
    writeFileSync(join(root, 'src/renamed_tests.rs'), '#[test]\nfn observes() { assert_eq!(crate::value(), 1); }\n');
    writeFileSync(join(root, 'src/active.rs'), '#[test]\nfn unrelated() { assert!(true); }\n');
    run('cargo', ['generate-lockfile', '--offline']);
    run('git', ['add', '.']); run('git', ['commit', '-qm', 'control']);
    const base = run('git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(root, 'src/lib.rs'), readFileSync(join(root, 'src/lib.rs'), 'utf8').replace('{ 1 }', '{ 2 }'));
    writeFileSync(join(root, 'src/renamed_tests.rs'), '#[test]\nfn observes() { assert_eq!(crate::value(), 2); }\n');
    run('git', ['add', '.']); run('git', ['commit', '-qm', 'change disabled witness']);
    const output = run(process.execPath, [oracle, '--root', root, '--base', base, '--ci', '--json'], 3);
    assert.match(output, /conditional or ambiguous/);
    assert.doesNotMatch(output, /"verdict": "UNOBSERVED"/);
    assert.equal(run('git', ['status', '--porcelain']).trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
