/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { boundedSpawnSync } from '../lib/bounded-process.mjs';
import { skipUnlessCommand } from '../lib/host-preconditions.mjs';
import { chooseToolchain } from '../lib/released-smoke-support.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = fileURLToPath(new URL('./build-at-ref.sh', import.meta.url));
const CARGO_SKIP = skipUnlessCommand('cargo', ['--version'], 'install rustup', process.env, { cwd: tmpdir() });
// RUSTUP_TOOLCHAIN outranks the ref's rust-toolchain.toml, and RUSTC_BOOTSTRAP
// makes a stable build apply [unstable] config (PR #10977 review).
const OVERRIDES = ['RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER',
  'CARGO_BUILD_RUSTC', 'CARGO_BUILD_RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER', 'RUSTUP_TOOLCHAIN',
  'RUSTC_BOOTSTRAP'];

// The script drops inherited GIT_* variables; the test's own git calls must
// too, or a hook's GIT_DIR would point them at another repository.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

// Drop overrides the caller's shell exports (e.g. RUSTC_WRAPPER=sccache).
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !OVERRIDES.includes(key)));

function buildAtRef(t, ref, env) {
  const directory = mkdtempSync(join(tmpdir(), 'build-at-ref-'));
  t.after(() => {
    // A hard timeout kills the script before its EXIT trap removes the
    // worktree. Remove only this test's, never the checkout's other worktrees.
    const listed = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', env: gitEnv });
    for (const [, path] of listed.matchAll(/^worktree (.+)$/gm)) {
      if (path.includes(basename(directory))) execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', path], { env: gitEnv });
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const worktreeRoot = join(directory, 'worktrees');
  // Skip CARGO_HOME's config too. cargo still reads ~/.cargo/config.toml when
  // the temp directory is under $HOME.
  const base = { ...baseEnv, CARGO_HOME: join(directory, 'cargo-home') };
  const run = (extra = []) => boundedSpawnSync('bash', [
    script, '--ref', ref, '--out', join(directory, 'probe'), '--worktree-root', worktreeRoot, ...extra,
  ], { encoding: 'utf8', env: { ...base, ...env }, timeout: 60_000 });
  return { directory, worktreeRoot, run };
}

// An empty RUSTC_*WRAPPER cancels only its own CARGO_BUILD_* counterpart.
for (const [name, value, extra = {}] of [
  ...OVERRIDES.map((name) => [name, '/alternate']), ['RUSTC', ''], ['CARGO_BUILD_RUSTC', ''],
  ['CARGO_BUILD_RUSTC_WRAPPER', '/alternate', { RUSTC_WORKSPACE_WRAPPER: '' }],
  ['CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER', '/alternate', { RUSTC_WRAPPER: '' }],
]) {
  test(`build-at-ref refuses ${name}=${JSON.stringify(value)} with ${JSON.stringify(extra)} before creating a worktree (#10965)`, (t) => {
    const { worktreeRoot, run } = buildAtRef(t, 'HEAD', { ...extra, [name]: value });
    const result = run();
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    const fix = /WRAPPER|RUSTUP|BOOTSTRAP/.test(name) ? `unset ${name} or set it empty` : `unset ${name}`;
    assert.ok(result.stderr.includes(`build-at-ref.sh: ${fix} before building (compiler override)`), result.stderr);
    assert.equal(existsSync(worktreeRoot), false);
  });
}

// An empty commit is enough for the config check and avoids checking out the
// repository. Fixed dates give the same object on every run.
function emptyRef() {
  const date = '2026-01-01T00:00:00Z';
  const git = (args, input) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', input,
    env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  }).trim();
  return git(['commit-tree', '--no-gpg-sign', '-m', 'build-at-ref test ref', git(['mktree'], '')]);
}

function withAncestorConfig(t, env, config, configDir = '.cargo') {
  const { directory, run } = buildAtRef(t, emptyRef(), env);
  mkdirSync(join(directory, configDir));
  writeFileSync(join(directory, configDir, 'config.toml'), config);
  const result = run();
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  return result.stderr;
}

// cargo prints values in whichever TOML string form fits them: '...' for a
// backslash, '''...''' for a backslash and a quote, """ for a newline. An
// empty rustc is refused too: cargo would try to run an empty path.
const HINTS = { 'rustc-wrapper': 'RUSTC_WRAPPER=', 'rustc-workspace-wrapper': 'RUSTC_WORKSPACE_WRAPPER=' };
for (const [env, line, configDir] of [
  [{}, `rustc = "/alternate/rustc"`],
  [{ RUSTC_WRAPPER: '', RUSTC_WORKSPACE_WRAPPER: '' }, `rustc = "/alternate/rustc"`],
  [{}, `rustc-wrapper = "/alternate/wrapper"`, 'cargo-home'],
  [{}, `rustc = ""`],
  [{}, `rustc = """/alternate\nrustc"""`],
  [{}, `rustc-wrapper = 'C:\\alternate\\wrapper'`],
  [{}, `rustc-wrapper = '''C:\\it's\\wrapper'''`],
  [{ RUSTC_WRAPPER: '' }, `rustc-workspace-wrapper = "/alternate/wrapper"`],
]) {
  const where = configDir ? 'CARGO_HOME' : 'an ancestor';
  test(`build-at-ref refuses ${JSON.stringify(`build.${line}`)} in ${where} Cargo config with ${JSON.stringify(env)} (#10965)`, { skip: CARGO_SKIP }, (t) => {
    const key = line.split(' = ')[0];
    const stderr = withAncestorConfig(t, env, `[build]\n${line}\n`, configDir);
    const hint = HINTS[key] ? `; or set ${HINTS[key]} for this run` : '';
    const file = join(configDir ?? '.cargo', 'config.toml');
    const refused = new RegExp(`remove build\\.${key} from \\S*${file.replaceAll('.', '\\.')} before building \\(compiler override`);
    assert.match(stderr, refused);
    assert.ok(stderr.includes(`(compiler override${hint})`), stderr);
  });
}

test('build-at-ref fails closed when cargo cannot read its config (#10965)', { skip: CARGO_SKIP }, (t) => {
  const stderr = withAncestorConfig(t, {}, '[build\n');
  assert.match(stderr, /could not parse TOML configuration/);
  assert.match(stderr, /cargo failed at \w+ before building \(config query/);
});

// Each empty variable turns off its own config wrapper; an empty config
// wrapper is no wrapper. The empty ref has no package, so the build fails.
for (const [name, key, other] of [
  ['RUSTC_WRAPPER', 'rustc-wrapper', 'rustc-workspace-wrapper'],
  ['CARGO_BUILD_RUSTC_WRAPPER', 'rustc-wrapper', 'rustc-workspace-wrapper'],
  ['RUSTC_WORKSPACE_WRAPPER', 'rustc-workspace-wrapper', 'rustc-wrapper'],
  ['CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER', 'rustc-workspace-wrapper', 'rustc-wrapper'],
]) {
  test(`build-at-ref passes the override check with ${name}= and an empty ${other} (#10965)`, { skip: CARGO_SKIP }, (t) => {
    const stderr = withAncestorConfig(t, { [name]: '' }, `[build]\n${key} = "/alternate/wrapper"\n${other} = ""\n`);
    assert.doesNotMatch(stderr, /compiler override|before building \(/);
    assert.match(stderr, /build-at-ref\.sh: building example perf_probe of ifc-lite-processing at \w+ failed/);
  });
}

test('build-at-ref lets an empty RUSTC_*WRAPPER cancel CARGO_BUILD_RUSTC_*WRAPPER (#10965)', { skip: CARGO_SKIP }, (t) => {
  // cargo reads RUSTC_WRAPPER first, so an empty one means no wrapper at all.
  const stderr = withAncestorConfig(t, {
    RUSTC_WRAPPER: '', CARGO_BUILD_RUSTC_WRAPPER: '/alternate/wrapper',
    RUSTC_WORKSPACE_WRAPPER: '', CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: '/alternate/wrapper',
  }, '');
  assert.doesNotMatch(stderr, /compiler override|before building \(/);
  assert.match(stderr, /build-at-ref\.sh: building example perf_probe of ifc-lite-processing at \w+ failed/);
});

test('build-at-ref checks config that --inject puts in the worktree (#10965)', { skip: CARGO_SKIP }, (t) => {
  const { directory, run } = buildAtRef(t, emptyRef(), {});
  // Not under .cargo/, so cargo reads it only once injected into the worktree.
  const config = join(directory, 'inject.toml');
  writeFileSync(config, '[build]\nrustc = "/alternate/rustc"\n');
  const result = run(['--inject', `${config}=.cargo/config.toml`]);
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  // The worktree is deleted on exit, so the message names the file as the ref has it.
  assert.match(result.stderr, /remove build\.rustc from \.cargo\/config\.toml at \w+ \(from the ref, --inject or --patch\) before building \(compiler override\)/);
});

test('build-at-ref accepts an empty RUSTUP_TOOLCHAIN, which rustup ignores (#10965)', { skip: CARGO_SKIP }, (t) => {
  const stderr = withAncestorConfig(t, { RUSTUP_TOOLCHAIN: '' }, '');
  assert.doesNotMatch(stderr, /compiler override|before building \(/);
  assert.match(stderr, /build-at-ref\.sh: building example perf_probe of ifc-lite-processing at \w+ failed/);
});

// On a stable cargo the build ignores [unstable] config, but the bootstrapped
// config query honours it, so the two could see different wrappers (PR #10977
// review, discussion_r4642674475). The empty ref has no rust-toolchain.toml,
// so this runs on the default toolchain, like the other cargo tests.
const defaultCargo = spawnSync('cargo', ['-V'], { cwd: tmpdir(), env: baseEnv, encoding: 'utf8', timeout: 15_000 }).stdout ?? '';
const NIGHTLY_DEFAULT = /-(nightly|dev)/.test(defaultCargo) && 'the default toolchain is nightly, which honours [unstable]';
test('build-at-ref refuses [unstable] config on a stable toolchain (#10965)', { skip: CARGO_SKIP || NIGHTLY_DEFAULT }, (t) => {
  const { directory, run } = buildAtRef(t, emptyRef(), {});
  mkdirSync(join(directory, '.cargo'));
  writeFileSync(join(directory, '.cargo', 'config.toml'), '[unstable]\nconfig-include = true\n');
  const result = run();
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /remove \[unstable\] from \S*\/\.cargo\/config\.toml before building: .* on a non-nightly cargo/);
});

// The pinned nightly honours [unstable] in both the build and the check, so it
// is not refused there. It needs that toolchain installed (nothing is
// fetched); scripts-tests installs none, so CI runs it only where the runner
// image has it.
const pinned = chooseToolchain({}, root, {}).name;
const PINNED_SKIP = spawnSync('rustup', ['run', pinned, 'cargo', '-V'], {
  env: { ...baseEnv, RUSTUP_AUTO_INSTALL: '0' }, encoding: 'utf8', timeout: 15_000,
}).status !== 0 && `${pinned} is not installed`;
test('build-at-ref accepts [unstable] config on the pinned nightly (#10965)', { skip: CARGO_SKIP || PINNED_SKIP }, (t) => {
  const { directory, run } = buildAtRef(t, emptyRef(), {});
  writeFileSync(join(directory, 'rust-toolchain.toml'), `[toolchain]\nchannel = "${pinned}"\n`);
  mkdirSync(join(directory, '.cargo'));
  writeFileSync(join(directory, '.cargo', 'config.toml'), '[unstable]\nconfig-include = true\n');
  const result = run();
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stderr, /\[unstable\]|compiler override|before building \(/);
  assert.match(result.stderr, /build-at-ref\.sh: building example perf_probe of ifc-lite-processing at \w+ failed/);
});
