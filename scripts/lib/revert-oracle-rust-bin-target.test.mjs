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

import { planRuns } from './revert-oracle-plan-runs.mjs';

const oracle = resolve(dirname(fileURLToPath(import.meta.url)), '../check-test-revert-oracle.mjs');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('#4700: a module test in a binary-only crate is attributed to its bin target and observes the revert', { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'oracle-rust-bin-'));
  const env = { ...process.env, CARGO_TARGET_DIR: join(root, 'target') };
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  const run = (bin, args) => {
    const result = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.error, undefined, `${bin}: ${result.error?.message}`);
    assert.equal(result.status, 0, `${bin} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  try {
    run('git', ['init', '-q']);
    run('git', ['config', 'user.name', 'Revert oracle fixture']);
    run('git', ['config', 'user.email', 'oracle@example.invalid']);
    mkdirSync(join(root, 'src/routes'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), '/target/\n');
    // No src/lib.rs: the only compiled root is src/main.rs, like apps/server.
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "oracle-rust-bin"\nversion = "0.1.0"\nedition = "2021"\n');
    // The attribute on a non-module item ahead of `mod routes;` is the
    // apps/server/src/main.rs shape: a declaration scan whose attribute run may
    // cross items swallowed every `mod` up to the next attributed one.
    writeFileSync(join(root, 'src/main.rs'), '#[allow(dead_code)]\nconst UNUSED: u32 = 0;\nmod value;\nmod routes;\n#[cfg(test)]\nmod value_tests;\nfn main() { println!("{}", value::value()); }\n');
    writeFileSync(join(root, 'src/routes/mod.rs'), '#[cfg(test)]\nmod nested_tests;\n');
    const writeVersion = (value) => {
      writeFileSync(join(root, 'src/value.rs'), `pub fn value() -> u32 { ${value} }\n`);
      for (const file of ['value_tests.rs', 'routes/nested_tests.rs']) {
        writeFileSync(join(root, 'src', file), `#[test]\nfn observes_value() { assert_eq!(crate::value::value(), ${value}); }\n`);
      }
    };
    writeVersion(1);
    run('cargo', ['generate-lockfile', '--offline']);
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'control']);
    const base = run('git', ['rev-parse', 'HEAD']).trim();
    writeVersion(2);
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'change production and both bin module assertions']);

    const { plans, unassigned } = planRuns(['src/value_tests.rs', 'src/routes/nested_tests.rs'], root);
    assert.deepEqual(unassigned, []);
    assert.deepEqual(plans.map((plan) => plan.runner.args), [
      ['test', '--no-fail-fast', '-p', 'oracle-rust-bin', '--bin', 'oracle-rust-bin', '--', 'value_tests::'],
      ['test', '--no-fail-fast', '-p', 'oracle-rust-bin', '--bin', 'oracle-rust-bin', '--', 'routes::nested_tests::'],
    ]);

    const output = run(process.execPath, [oracle, '--root', root, '--base', base, '--ci', '--json']);
    assert.match(output, /"verdict": "OBSERVED"/);
    assert.match(output, /reverting production turned an assertion RED in src\/(?:value_tests|routes\/nested_tests)\.rs/);
    assert.doesNotMatch(output, /cannot be attributed/);
    assert.equal(run('git', ['status', '--porcelain']).trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#4700: apps/server module tests are attributed to the ifc-lite-server bin target', () => {
  const { plans, unassigned } = planRuns(['apps/server/src/config_tests.rs', 'apps/server/src/cors_tests.rs'], repoRoot);
  assert.deepEqual(unassigned, []);
  assert.deepEqual(plans.map((plan) => [plan.moduleFilter, plan.runner.args.slice(3, 7)]), [
    ['config::config_tests', ['ifc-lite-server', '--bin', 'ifc-lite-server', '--']],
    ['cors_tests', ['ifc-lite-server', '--bin', 'ifc-lite-server', '--']],
  ]);
});
