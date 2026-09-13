/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { ledgerVerdict } from './revert-oracle-ledger.mjs';

const oracle = resolve(dirname(fileURLToPath(import.meta.url)), '../check-test-revert-oracle.mjs');

const pass = (total = 2) => ({ kind: 'pass', passed: total, failed: 0, total, attributed: true, exitCode: 0, signal: null, testIdentities: [], evidence: [] });
const red = (total = 2) => ({ kind: 'assertion-failure', passed: total - 1, failed: 1, total, attributed: true, exitCode: 1, signal: null, testIdentities: [], evidence: [] });
const unbuilt = { kind: 'load-failure', passed: null, failed: null, total: null, attributed: false, exitCode: 101, signal: null, testIdentities: [], evidence: ['cargo compile error: error[E0425]: cannot find function `value` in module `crate`'] };

test('#4700: a revert that breaks the build is its own blocking verdict naming the compile error', () => {
  const alone = ledgerVerdict([{ file: 'src/value_tests.rs', role: 'executable', baseline: pass(), reverted: unbuilt }]);
  assert.equal(alone.verdict, 'REVERT-BROKE-BUILD');
  assert.notEqual(alone.exitCode, 0);
  assert.match(alone.reason, /src\/value_tests\.rs/);
  assert.match(alone.reason, /E0425/);
  assert.match(alone.reason, /no assertion ran/);
  assert.match(alone.advice, /--mutation/);

  // A green sibling cannot turn the unmeasured file into UNOBSERVED.
  assert.equal(ledgerVerdict([
    { file: 'a.test.mjs', role: 'executable', baseline: pass(), reverted: pass() },
    { file: 'src/value_tests.rs', role: 'executable', baseline: pass(), reverted: unbuilt },
  ]).verdict, 'REVERT-BROKE-BUILD');
  // A real witness elsewhere still decides OBSERVED.
  assert.equal(ledgerVerdict([
    { file: 'a.test.mjs', role: 'executable', runKey: 'a', baseline: pass(), reverted: red() },
    { file: 'src/value_tests.rs', role: 'executable', baseline: pass(), reverted: unbuilt },
  ]).verdict, 'OBSERVED');
  // A broken baseline is not a revert effect.
  assert.equal(ledgerVerdict([
    { file: 'src/value_tests.rs', role: 'executable', baseline: unbuilt, reverted: unbuilt },
  ]).verdict, 'BASELINE-BROKEN');
  // An oracle capability gap is still reported as the oracle's gap.
  assert.equal(ledgerVerdict([
    { file: 'src/value_tests.rs', role: 'executable', baseline: pass(), reverted: unbuilt },
    { file: 'tests/helper.rs', role: 'capability-gap', reason: 'not attributable' },
  ]).verdict, 'INCONCLUSIVE');
});

test('#4700: the oracle reports a Rust revert that no longer compiles as REVERT-BROKE-BUILD, not an attribution gap', { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-rust-compile-'));
  const env = { ...process.env, CARGO_TARGET_DIR: join(root, 'target') };
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  const run = (bin, args, expected = 0) => {
    const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.error, undefined, `${bin}: ${result.error?.message}`);
    assert.equal(result.status, expected, `${bin} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  try {
    run('git', ['init', '-q']);
    run('git', ['config', 'user.name', 'Revert oracle fixture']);
    run('git', ['config', 'user.email', 'oracle@example.invalid']);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, '.gitignore'), '/target/\n');
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "oracle-rust-compile"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, 'src/lib.rs'), 'pub fn unrelated() -> u32 { 0 }\n#[cfg(test)]\nmod value_tests;\n');
    writeFileSync(join(root, 'src/value_tests.rs'), '#[test]\nfn unrelated_is_zero() { assert_eq!(crate::unrelated(), 0); }\n');
    run('cargo', ['generate-lockfile', '--offline']);
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'control']);
    const base = run('git', ['rev-parse', 'HEAD']).trim();
    // The branch adds a function and a test that calls it: reverting the
    // production hunk deletes the function, so the test cannot compile (E0425).
    writeFileSync(join(root, 'src/lib.rs'), 'pub fn unrelated() -> u32 { 0 }\npub fn value() -> u32 { 2 }\n#[cfg(test)]\nmod value_tests;\n');
    writeFileSync(join(root, 'src/value_tests.rs'), '#[test]\nfn value_is_two() { assert_eq!(crate::value(), 2); }\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'add value and its test']);

    const output = run(process.execPath, [oracle, '--root', root, '--base', base, '--ci', '--json'], 3);
    const payload = JSON.parse(output.slice(output.lastIndexOf('\n{\n') + 1));
    assert.equal(payload.verdict, 'REVERT-BROKE-BUILD');
    assert.equal(payload.channel, 'oracle');
    assert.match(payload.reason, /src\/value_tests\.rs/);
    assert.match(payload.reason, /E0425/);
    assert.doesNotMatch(payload.reason, /attribution gap/);
    assert.match(output, /! REVERT-BROKE-BUILD {2}<-- NO ASSERTION RAN/);
    assert.equal(run('git', ['status', '--porcelain']).trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
