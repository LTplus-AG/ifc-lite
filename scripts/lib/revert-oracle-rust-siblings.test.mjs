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
    writeFileSync(join(root, 'src/lib.rs'), 'pub mod value;\n#[cfg(test)] mod value_tests;\n#[cfg(test)] mod tests;\n');
    // A later Cargo target must still execute after the library target fails.
    // Its supported-version invariant holds for both production revisions.
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests/later_target.rs'),
      '#[test]\nfn version_stays_supported() { assert!((1..=2).contains(&oracle_rust_siblings::value::value())); }\n');
    const writeVersion = (value) => {
      writeFileSync(join(root, 'src/value.rs'), `pub fn value() -> u32 { ${value} }\n`);
      for (const file of ['value_tests.rs', 'tests.rs']) {
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
    assert.match(output, /2 assertion\(s\) RED out of 3 collected/);
    assert.equal(readFileSync(join(root, 'src/value.rs'), 'utf8'), 'pub fn value() -> u32 { 2 }\n');
    assert.equal(run('git', ['status', '--porcelain']).trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
