/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * End-to-end proof, real Cargo, that an UnhandledCfgShapeError (thrown by
 * detectRequiredFeatureCombos in lib/revert-oracle-rust-features.mjs for a
 * cfg shape it refuses to silently misplan a run for) is delivered as a
 * structured, distinguishable failure instead of an unhandled crash.
 *
 * planRuns() — and the requiredFeatureCombos() call inside it — runs at
 * module top level in check-test-revert-oracle.mjs, BEFORE the tool's own
 * try{}/uncaughtException handler is registered. Left uncaught this is a
 * genuine unhandled synchronous exception: a raw stack trace on stderr, no
 * JSON despite --json, and Node's default exit code of 1 — which collides
 * with EXIT_UNOBSERVED, so a CI consumer keyed on exit code cannot tell
 * "the oracle could not even plan this branch's runs" from "the branch's
 * tests did not observe the change". This proves the fix: the exception is
 * caught, die()'s ABORT formatting is used, JSON is still emitted when
 * --json is passed, and the exit code is neither 0 (OBSERVED) nor 1
 * (UNOBSERVED).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const oracle = resolve(dirname(fileURLToPath(import.meta.url)), '../check-test-revert-oracle.mjs');
const EXIT_OBSERVED = 0;
const EXIT_UNOBSERVED = 1;
const EXIT_UNHANDLED_CFG_SHAPE = 6;

function makeCrate() {
  const root = mkdtempSync(join(tmpdir(), 'oracle-unhandled-cfg-'));
  const env = { ...process.env, CARGO_TARGET_DIR: join(root, 'target') };
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  function run(bin, args) {
    const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.error, undefined, `${bin}: ${result.error?.message}`);
    assert.equal(result.status, 0, `${bin} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }
  run('cargo', ['--version']);
  run('git', ['init', '-q']);
  run('git', ['config', 'user.name', 'Revert oracle fixture']);
  run('git', ['config', 'user.email', 'oracle@example.invalid']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, '.gitignore'), '/target/\n');
  writeFileSync(
    join(root, 'Cargo.toml'),
    '[package]\nname = "oracle-unhandled-cfg"\nversion = "0.1.0"\nedition = "2021"\n\n' +
      '[features]\ndefault = []\ngate_a = []\n',
  );
  writeFileSync(join(root, 'src/lib.rs'), 'pub fn value() -> u32 { 1 }\n');
  run('cargo', ['generate-lockfile', '--offline']);
  run('git', ['add', '.']);
  run('git', ['commit', '-qm', 'control']);
  const base = run('git', ['rev-parse', 'HEAD']).trim();
  // A `not(...)` cfg gate above a real #[test] — the shape
  // detectRequiredFeatureCombos throws UnhandledCfgShapeError for.
  mkdirSync(join(root, 'tests'));
  writeFileSync(
    join(root, 'tests/gated.rs'),
    '#[cfg(not(feature = "gate_a"))]\n#[test]\nfn gated_test() { assert!(true); }\n',
  );
  writeFileSync(join(root, 'src/lib.rs'), 'pub fn value() -> u32 { 2 }\n');
  run('git', ['add', '.']);
  run('git', ['commit', '-qm', 'change production and add a not(...) gated test']);
  return { root, base, env };
}

test(
  'UnhandledCfgShapeError from planRuns() is caught, not an unhandled crash: distinct exit code, no ambiguity with EXIT_UNOBSERVED',
  { timeout: 60_000 },
  () => {
    const { root, base, env } = makeCrate();
    try {
      const result = spawnSync(
        process.execPath,
        [oracle, '--root', root, '--base', base, '--ci', '--json'],
        { cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      );
      // Not an unhandled-exception exit and not EXIT_UNOBSERVED: a CI consumer
      // keyed on exit code must be able to tell this apart from "tests ran and
      // did not observe the change".
      assert.equal(result.status, EXIT_UNHANDLED_CFG_SHAPE, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.notEqual(result.status, EXIT_OBSERVED);
      assert.notEqual(result.status, EXIT_UNOBSERVED);
      // die()'s own ABORT formatting, not a raw Node stack trace.
      assert.match(result.stderr, /\[revert-oracle\] ABORT:/);
      assert.doesNotMatch(result.stderr, /at parseCfgExpr/);
      // JSON was still emitted despite the crash path, per --json.
      const jsonStart = result.stdout.indexOf('{');
      assert.ok(jsonStart >= 0, `no JSON in stdout:\n${result.stdout}`);
      const payload = JSON.parse(result.stdout.slice(jsonStart));
      assert.equal(payload.verdict, 'ERROR');
      assert.equal(payload.error.name, 'UnhandledCfgShapeError');
      assert.equal(payload.error.shape, 'not(...)');
      assert.match(payload.reason, /not\(\.\.\.\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
