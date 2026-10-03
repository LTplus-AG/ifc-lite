/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { compilerEnvironment } from './native-hosted-process.mjs';
import { repositoryNightlyChannel } from './native-hosted-prepare.mjs';

test('#6537 real Cargo builds and documents with the frozen compiler despite hostile PATH and inherited selection', t => {
  const channel = repositoryNightlyChannel();
  const resolveTool = name => spawnSync('rustup', ['which', '--toolchain', channel, name], { encoding: 'utf8', timeout: 30000 });
  const compiler = resolveTool('rustc');
  if (process.env.NATIVE_COMPILER_CONTROL_REQUIRED === '1') assert.equal(compiler.status, 0, compiler.stderr || String(compiler.error));
  if (compiler.error?.code === 'ENOENT' || compiler.status !== 0) {
    t.skip('repository Rust toolchain unavailable; native hosted workflow installs it before this control'); return;
  }
  const tools = { rustc: realpathSync(compiler.stdout.trim()) };
  for (const name of ['cargo', 'rustdoc']) {
    const result = resolveTool(name); assert.equal(result.status, 0, result.stderr); tools[name] = realpathSync(result.stdout.trim());
  }
  tools.toolchain = basename(dirname(dirname(tools.rustc)));
  const sandbox = mkdtempSync(join(tmpdir(), 'ifc-native-compiler-'));
  try {
    const trap = join(sandbox, 'hostile'); mkdirSync(trap);
    const marker = join(sandbox, 'hostile-invocations'), observed = join(sandbox, 'compiler-observed');
    for (const name of ['rustc', 'rustdoc']) writeFileSync(join(trap, name), `#!/bin/sh\necho ${name} > '${marker}'\nexit 86\n`, { mode: 0o755 });
    writeFileSync(join(sandbox, 'Cargo.toml'), '[package]\nname="native_compiler_control"\nversion="0.0.0"\nedition="2021"\n');
    mkdirSync(join(sandbox, 'src'));
    writeFileSync(join(sandbox, 'src/main.rs'), 'fn main() { assert_eq!(7 * 9, 63); println!("pinned compiler executed"); }\n');
    writeFileSync(join(sandbox, 'build.rs'), `fn main() {
      let output = std::process::Command::new(std::env::var("RUSTC").unwrap()).args(["--version", "--verbose"]).output().unwrap();
      assert!(output.status.success());
      std::fs::write(std::env::var("COMPILER_OBSERVED").unwrap(), output.stdout).unwrap();
    }\n`);
    const hostile = { ...process.env, PATH: `${trap}:${process.env.PATH}`, RUSTC: join(trap, 'rustc'),
      RUSTDOC: join(trap, 'rustdoc'), RUSTUP_TOOLCHAIN: 'stable', COMPILER_OBSERVED: observed,
      CARGO_BUILD_JOBS: '1', CARGO_TERM_COLOR: 'never' };
    for (const key of ['CARGO_TARGET_DIR', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER']) delete hostile[key];
    const run = (program, args, env) => spawnSync(program, args, { cwd: sandbox, env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 ** 2 });
    const negative = run(tools.cargo, ['build', '--offline', '--target-dir', 'negative-target'], hostile);
    assert.notEqual(negative.status, 0, 'unfixed direct Cargo must fail through the hostile compiler');
    assert.equal(readFileSync(marker, 'utf8'), 'rustc\n'); rmSync(marker);
    const pinned = compilerEnvironment(hostile, tools);
    const shim = spawnSync('which', ['cargo'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(shim.status, 0, shim.stderr);
    const rustupPath = spawnSync('which', ['rustup'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(rustupPath.status, 0, rustupPath.stderr);
    assert.equal(realpathSync(shim.stdout.trim()), realpathSync(rustupPath.stdout.trim()), 'Cargo shim is the observed rustup proxy');
    const shimVersion = run(shim.stdout.trim(), ['--version'], pinned), directVersion = run(tools.cargo, ['--version'], pinned);
    assert.equal(shimVersion.status, 0, shimVersion.stderr); assert.equal(directVersion.status, 0, directVersion.stderr);
    assert.equal(shimVersion.stdout, directVersion.stdout, 'Cargo shim selects the same frozen toolchain outside repository ancestry');
    const built = run(tools.cargo, ['build', '--offline', '--target-dir', 'positive-target'], pinned);
    assert.equal(built.status, 0, built.stderr);
    const expected = run(tools.rustc, ['--version', '--verbose'], pinned);
    assert.equal(expected.status, 0, expected.stderr);
    assert.equal(readFileSync(observed, 'utf8'), expected.stdout, 'real build script used the frozen compiler');
    const executed = run(join(sandbox, 'positive-target/debug/native_compiler_control'), [], pinned);
    assert.equal(executed.status, 0, executed.stderr); assert.equal(executed.stdout, 'pinned compiler executed\n');
    const documented = run(tools.cargo, ['doc', '--offline', '--no-deps', '--target-dir', 'positive-target'], pinned);
    assert.equal(documented.status, 0, documented.stderr);
    assert.ok(existsSync(join(sandbox, 'positive-target/doc/native_compiler_control/index.html')));
    assert.equal(existsSync(marker), false, 'neither hostile compiler nor hostile rustdoc ran');
    assert.throws(() => compilerEnvironment(hostile, { ...tools, toolchain: 'stable' }), /selection refused/);
    assert.throws(() => compilerEnvironment(hostile, { ...tools, rustdoc: '/foreign/bin/rustdoc' }), /selection refused/);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});
