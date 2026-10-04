/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { repositoryNightlyChannel } from './native-hosted-prepare.mjs';

// #6537 independent compiler behavior, not an assertion about the matcher.
// Poisoned crate-body macros/modules must never be expanded by this exact query.
// rustc may read its libraries and stdin/attributes; no syscall-read claim is made.
test('#6537 pinned Cargo target-information query prints without ordinary crate compilation', t => {
  const selected = spawnSync('rustup', ['which', '--toolchain', repositoryNightlyChannel(), 'rustc'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 131072 });
  if (selected.status !== 0 || selected.error) {
    const reason = `repository-pinned rustc unavailable: ${selected.stderr || selected.error}`;
    if (process.env.NATIVE_COMPILER_CONTROL_REQUIRED === '1') assert.fail(reason);
    t.skip(reason); return;
  }
  const rustc = realpathSync(selected.stdout.trim());
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const frozenHash = hash(readFileSync(rustc));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'rustc-query-semantics-')));
  const poison = '#![allow(dead_code)]\ncompile_error!("BODY_COMPILATION_MUST_FAIL_6537");\nmod never_open_body_6537;\nfn main() {}\n';
  const query = ['-', '--crate-name', '___', '--print=file-names',
    '--crate-type', 'bin', '--crate-type', 'rlib', '--crate-type', 'dylib',
    '--crate-type', 'cdylib', '--crate-type', 'staticlib', '--crate-type', 'proc-macro',
    '--print=sysroot', '--print=split-debuginfo', '--print=crate-name', '--print=cfg', '-Wwarnings'];
  const receipt = { rustc, frozenSha256: frozenHash, stdinSha256: hash(poison), cwd, scope: 'compiler-print semantics; no performance evidence' };
  try {
    const options = { cwd, input: poison, encoding: 'utf8', timeout: 15000, maxBuffer: 131072 };
    const printed = spawnSync(rustc, query, options);
    receipt.query = { argv: [rustc, ...query], status: printed.status, signal: printed.signal,
      stdout: printed.stdout, stderr: printed.stderr, error: printed.error?.message, files: readdirSync(cwd) };
    assert.ifError(printed.error);
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(printed.signal, null);
    assert.equal(printed.stderr, '');
    assert.ok(printed.stdout.split('\n').includes('___'), 'declared crate-name delimiter is printed');
    assert.ok(printed.stdout.split('\n').includes(dirname(dirname(rustc))), 'actual pinned sysroot is printed');
    assert.match(printed.stdout, /^target_arch=".+"$/m, 'target configuration is printed');
    assert.deepEqual(receipt.query.files, [], 'read-only query emits no files in its owned directory');

    // Same stdin/body under ordinary compilation must expose BOTH expansion
    // failures. One bin type avoids unrelated mixed-crate-type validation errors.
    const compileArgs = ['-', '--crate-name', '___', '--crate-type', 'bin', '--emit=metadata', '-Wwarnings'];
    const compiled = spawnSync(rustc, compileArgs, options);
    receipt.ordinaryCompilation = { argv: [rustc, ...compileArgs], status: compiled.status, signal: compiled.signal,
      stdout: compiled.stdout, stderr: compiled.stderr, error: compiled.error?.message, files: readdirSync(cwd) };
    assert.ifError(compiled.error);
    assert.notEqual(compiled.status, 0, 'identical poisoned body fails when ordinary compilation executes');
    assert.equal(compiled.signal, null);
    assert.match(compiled.stderr, /BODY_COMPILATION_MUST_FAIL_6537/);
    assert.match(compiled.stderr, /never_open_body_6537/);
    assert.deepEqual(receipt.ordinaryCompilation.files, [], 'failed semantic control leaves no generated files');
    assert.equal(hash(readFileSync(rustc)), frozenHash, 'exact compiler bytes remain unchanged');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    receipt.ownedDirectoryRemoved = true;
    t.diagnostic(JSON.stringify(receipt));
  }
});
