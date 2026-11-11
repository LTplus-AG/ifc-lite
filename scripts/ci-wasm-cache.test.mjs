/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The WASM build cache (scripts/ci-wasm-cache.mjs). The failure that matters
 * is a stale build used as fresh, so most cases here are about keys that must
 * move and restored trees that must be refused.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeMode,
  planDecision,
  resolveDecision,
  parseInputEntries,
  readInputList,
  inputManifest,
  cacheKey,
  recordOutputs,
  verifyRestored,
  readManifest,
  diffFiles,
  cleanOutputs,
  OUTPUT_DIRS,
  REQUIRED_OUTPUTS,
  INPUTS_FILE,
} from './ci-wasm-cache.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'ci-wasm-cache.mjs');
const BASE_ENV = { RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', HOME: '/home/runner' };

test('only the exact strings `shadow` and `on` leave the cache off', () => {
  for (const raw of ['shadow', 'on']) assert.equal(normalizeMode(raw), raw);
  for (const raw of [undefined, '', 'off', 'ON', 'Shadow', ' on', 'true', '1', 'yes']) {
    assert.equal(normalizeMode(raw), 'off', `${JSON.stringify(raw)}`);
  }
});

test('plan: only an `on` ordinary PR run may skip the build; only refs a later run reads may save', () => {
  const main = 'refs/heads/main';
  const pr = 'refs/pull/7/merge';
  const queue = 'refs/heads/gh-readonly-queue/main/pr-7-abc';
  const rows = [
    // mode, event, batch, ref -> active, verify, store
    ['off', 'pull_request', 'false', pr, false, false, false],
    ['off', 'push', 'false', main, false, false, false],
    ['shadow', 'pull_request', 'false', pr, true, true, true],
    ['shadow', 'push', 'false', main, true, true, true],
    ['on', 'pull_request', 'false', pr, true, false, true],
    ['on', 'pull_request', 'true', pr, true, true, false],
    ['on', 'push', 'false', main, true, true, true],
    ['on', 'merge_group', 'false', queue, true, true, false],
    ['on', 'workflow_dispatch', 'false', 'refs/heads/topic', true, true, false],
    ['on', 'workflow_dispatch', 'false', main, true, true, true],
    ['on', undefined, undefined, undefined, true, true, false],
  ];
  for (const [mode, event, batch, ref, active, verify, store] of rows) {
    assert.deepEqual(planDecision({ mode, event, batch, ref }), { active, verify, store }, `${mode}/${event}/${batch}/${ref}`);
  }
});

test('resolve: restored output is used only on a verified hit in a non-verify run', () => {
  const rows = [
    // verify, store, hit, valid -> build, compare, save, rejected
    [false, true, true, true, false, false, false, false],
    [false, true, true, false, true, false, false, true],
    [false, true, false, false, true, false, true, false],
    [false, false, false, false, true, false, false, false],
    [true, true, true, true, true, true, false, false],
    [true, true, true, false, true, false, false, true],
    [true, true, false, false, true, false, true, false],
    [true, false, false, false, true, false, false, false],
  ];
  for (const [verify, store, hit, valid, build, compare, save, rejected] of rows) {
    assert.deepEqual(
      resolveDecision({ verify, store, hit, valid }),
      { build, compare, save, rejected },
      `${verify}/${store}/${hit}/${valid}`,
    );
  }
});

const parseInputList = (text) => parseInputEntries(text).map((entry) => entry.path);

test('parseInputEntries strips comments and refuses paths that cannot be repo-relative', () => {
  assert.deepEqual(parseInputList('# c\nrust  # crates\n\nCargo.lock\n'), ['rust', 'Cargo.lock']);
  assert.throws(() => parseInputList('# only comments\n'), /lists no paths/);
  assert.throws(() => parseInputList('/etc/passwd\n'), /not a repo-relative path/);
  assert.throws(() => parseInputList('rust/../x\n'), /not a repo-relative path/);
  assert.throws(() => parseInputList('a b\n'), /not a repo-relative path/);
  assert.throws(() => parseInputList('cache-only:\n'), /not a repo-relative path/);
  assert.deepEqual(parseInputEntries('rust\ncache-only:scripts/probe.sh\n'), [
    { path: 'rust', cacheOnly: false },
    { path: 'scripts/probe.sh', cacheOnly: true },
  ]);
});

test('published-paths leaves out cache-only entries, and names a bad entry instead of printing nothing silently', () => {
  const root = makeScriptRepo();
  try {
    commit(root, INPUTS_FILE, 'rust\ncache-only:Cargo.lock\n');
    assert.deepEqual(readInputList(root), ['rust', 'Cargo.lock']);
    const ok = cli(root, ['published-paths'], {});
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, 'rust\n');
    commit(root, INPUTS_FILE, 'cache-only:rust\n');
    const none = cli(root, ['published-paths'], {});
    assert.equal(none.status, 1, 'an all-cache-only list must not print an empty path');
    assert.equal(none.stdout, '');
    commit(root, INPUTS_FILE, 'rust\n/abs\n');
    const bad = cli(root, ['published-paths'], {});
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /'\/abs' is not a repo-relative path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'wasm-cache-'));
  mkdirSync(join(root, 'rust', 'core'), { recursive: true });
  mkdirSync(join(root, 'packages', 'wasm', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'rust', 'core', 'lib.rs'), 'pub fn f() {}\n');
  writeFileSync(join(root, 'Cargo.lock'), 'lock v1\n');
  writeFileSync(join(root, 'packages', 'wasm', 'pkg', 'ifc-lite.d.ts'), 'committed\n');
  git(root, 'init', '-q', '.');
  git(root, 'config', 'user.email', 'harness@example.invalid');
  git(root, 'config', 'user.name', 'harness');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

function commit(root, file, content) {
  writeFileSync(join(root, file), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `edit ${file}`);
}

const keyOf = (root, env = BASE_ENV) => cacheKey(inputManifest({ cwd: root, paths: ['rust', 'Cargo.lock'], env }), env);

test('the key moves with every listed input and with build env, and not with other files', () => {
  const root = makeRepo();
  try {
    const base = keyOf(root);
    assert.match(base, /^wasm-build-v1-Linux-X64-[0-9a-f]{64}$/);
    commit(root, 'README.md', 'docs\n');
    assert.equal(keyOf(root), base, 'an unlisted file must not change the key');
    commit(root, 'rust/core/lib.rs', 'pub fn g() {}\n');
    const afterRust = keyOf(root);
    assert.notEqual(afterRust, base, 'a nested Rust change must change the key');
    commit(root, 'Cargo.lock', 'lock v2\n');
    assert.notEqual(keyOf(root), afterRust, 'a lock change must change the key');
    const now = keyOf(root);
    for (const env of [
      { ...BASE_ENV, DEBUG_GEOMETRY: '1' },
      { ...BASE_ENV, RUSTFLAGS: '-C opt-level=1' },
      { ...BASE_ENV, CARGO_PROFILE_RELEASE_LTO: 'false' },
      { ...BASE_ENV, HOME: '/home/other' },
      { ...BASE_ENV, RUNNER_ARCH: 'ARM64' },
      { ...BASE_ENV, DEBUG_GEOMETRY: '' },
    ]) {
      assert.notEqual(keyOf(root, env), now, JSON.stringify(env));
    }
    assert.equal(keyOf(root, { ...BASE_ENV, PATH: '/elsewhere', GITHUB_SHA: 'abc' }), now, 'unrelated env must not change the key');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a listed path missing at HEAD, or an input edited in the working tree, refuses to key', () => {
  const root = makeRepo();
  try {
    assert.throws(() => inputManifest({ cwd: root, paths: ['rustXX'], env: BASE_ENV }), /'rustXX' does not exist at HEAD/);
    writeFileSync(join(root, 'rust', 'core', 'lib.rs'), 'uncommitted\n');
    assert.throws(() => keyOf(root), /differ from HEAD/);
    git(root, 'checkout', '--', 'rust');
    writeFileSync(join(root, 'rust', 'core', 'new.rs'), 'untracked\n');
    assert.throws(() => keyOf(root), /differ from HEAD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeBuild(root, tweak = '') {
  for (const path of REQUIRED_OUTPUTS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `${path}${tweak}`);
  }
}

test('a restored tree is accepted only when it is exactly the recorded build for this key', () => {
  const root = makeRepo();
  try {
    fakeBuild(root);
    recordOutputs(root, 'k1');
    assert.doesNotThrow(() => verifyRestored(root, 'k1'));
    assert.throws(() => verifyRestored(root, 'k2'), /manifest key k1 != k2/);
    writeFileSync(join(root, 'packages/wasm/pkg/ifc-lite_bg.wasm'), 'corrupt');
    assert.throws(() => verifyRestored(root, 'k1'), /ifc-lite_bg\.wasm/);
    fakeBuild(root);
    writeFileSync(join(root, 'packages/wasm/pkg/extra.js'), 'x');
    assert.throws(() => verifyRestored(root, 'k1'), /extra\.js/);
    rmSync(join(root, 'packages/wasm/pkg/extra.js'));
    rmSync(join(root, 'packages/wasm/pkg-rhino'), { recursive: true });
    assert.throws(() => verifyRestored(root, 'k1'), /pkg-rhino is missing/);
    // An entry consistent with its own manifest but recorded without a file
    // record requires now is still refused.
    fakeBuild(root);
    rmSync(join(root, 'packages/wasm/pkg-diff-decode-test/ifc-lite-diff_bg.wasm'));
    const manifest = readManifest(root);
    delete manifest.files['packages/wasm/pkg-diff-decode-test/ifc-lite-diff_bg.wasm'];
    writeFileSync(join(root, '.ci-wasm-cache/manifest.json'), JSON.stringify(manifest));
    assert.throws(() => verifyRestored(root, 'k1'), /entry lacks packages\/wasm\/pkg-diff-decode-test/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('record refuses a build that wrote a pkg* dir the cache would leave out', () => {
  const root = makeRepo();
  try {
    // A dir holding only committed files is not build output.
    mkdirSync(join(root, 'packages/wasm/pkg-retained'), { recursive: true });
    commit(root, 'packages/wasm/pkg-retained/ifc-lite.d.ts', 'committed\n');
    fakeBuild(root);
    assert.doesNotThrow(() => recordOutputs(root, 'k'));
    writeFileSync(join(root, 'packages/wasm/pkg-retained/ifc-lite_bg.wasm'), 'built');
    mkdirSync(join(root, 'packages/wasm/pkg-new'), { recursive: true });
    writeFileSync(join(root, 'packages/wasm/pkg-new/x.wasm'), 'built');
    assert.throws(() => recordOutputs(root, 'k'), /wrote packages\/wasm\/pkg-new, packages\/wasm\/pkg-retained/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('record refuses a build that lacks a required output, and refuses an empty key', () => {
  const root = makeRepo();
  try {
    fakeBuild(root);
    rmSync(join(root, 'packages/wasm/pkg-diff-decode-test/ifc-lite-diff_bg.wasm'));
    assert.throws(() => recordOutputs(root, 'k'), /missing packages\/wasm\/pkg-diff-decode-test/);
    fakeBuild(root);
    assert.throws(() => recordOutputs(root, ''), /no cache key/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diffFiles reports changed, added and removed files', () => {
  assert.deepEqual(diffFiles({ a: '1', b: '2' }, { a: '1', b: '2' }), []);
  assert.deepEqual(
    diffFiles({ a: '1', b: '2' }, { a: '9', c: '3' }).map((d) => d.path),
    ['a', 'b', 'c'],
  );
});

test('clean returns the output dirs to the checkout, tracked files included', () => {
  const root = makeRepo();
  try {
    fakeBuild(root, '-restored');
    recordOutputs(root, 'k');
    cleanOutputs(root);
    for (const dir of OUTPUT_DIRS.slice(1)) assert.equal(existsSync(join(root, dir)), false, dir);
    assert.equal(existsSync(join(root, '.ci-wasm-cache')), false);
    assert.equal(git(root, 'status', '--porcelain', '--', 'packages'), '', 'tracked outputs back to HEAD');
    assert.equal(existsSync(join(root, 'packages/wasm/pkg/ifc-lite.d.ts')), true);
    assert.equal(existsSync(join(root, 'packages/wasm/pkg/ifc-lite_bg.wasm')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A temp repo carrying its own copy of the script, so the CLI keys on it. */
function makeScriptRepo() {
  const root = makeRepo();
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  copyFileSync(SCRIPT, join(root, 'scripts', 'ci-wasm-cache.mjs'));
  copyFileSync(join(HERE, 'lib', 'is-main-entry.mjs'), join(root, 'scripts', 'lib', 'is-main-entry.mjs'));
  writeFileSync(join(root, INPUTS_FILE), '# test list\nrust\nCargo.lock\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'script');
  return root;
}

function cli(root, args, env) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'ci-wasm-cache.mjs'), ...args], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, ...env },
  });
}

test('CLI end to end: plan, record, then a hit is used by an `on` PR run and refused once tampered', () => {
  const root = makeScriptRepo();
  const temp = mkdtempSync(join(tmpdir(), 'wasm-cache-temp-'));
  try {
    const off = cli(root, ['plan'], { GITHUB_EVENT_NAME: 'pull_request' });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.stdout, 'mode=off\nactive=false\nverify=false\n');

    const env = { ...BASE_ENV, CI_WASM_CACHE: 'on', GITHUB_EVENT_NAME: 'pull_request', PR_BATCH: 'false', RUNNER_TEMP: temp };
    const plan = cli(root, ['plan'], env);
    assert.equal(plan.status, 0, plan.stderr);
    const key = plan.stdout.match(/^key=(wasm-build-v1-Linux-X64-[0-9a-f]{64})$/m)?.[1];
    assert.ok(key, plan.stdout);
    assert.match(plan.stdout, /^mode=on\nactive=true\nverify=false\n/);
    assert.match(plan.stdout, /paths<<__WASM_CACHE_EOF__\npackages\/wasm\/pkg\n[\s\S]*\.ci-wasm-cache\n__WASM_CACHE_EOF__\n$/);

    fakeBuild(root);
    const record = cli(root, ['record'], { WASM_CACHE_KEY: key });
    assert.equal(record.status, 0, record.stderr);

    assert.match(plan.stdout, /^store=true$/m, 'an ordinary PR saves to its own ref');
    const resolveEnv = { WASM_CACHE_MODE: 'on', WASM_CACHE_VERIFY: 'false', WASM_CACHE_STORE: 'true', WASM_CACHE_HIT: 'true', WASM_CACHE_KEY: key, RUNNER_TEMP: temp };
    const hit = cli(root, ['resolve'], resolveEnv);
    assert.equal(hit.stdout, 'build=false\ncompare=false\nsave=false\nrejected=false\n', hit.stderr);

    writeFileSync(join(root, 'packages/wasm/pkg/ifc-lite.js'), 'tampered');
    const tampered = cli(root, ['resolve'], resolveEnv);
    assert.equal(
      tampered.stdout.split('\n').filter((l) => /^(build|compare|save|rejected)=/.test(l)).join(' '),
      'build=true compare=false save=false rejected=true',
    );
    assert.match(tampered.stdout, /::warning title=WASM build cache entry rejected::/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

test('plan CLI turns the cache off, with a warning, when the input list has a typo', () => {
  const root = makeScriptRepo();
  try {
    commit(root, INPUTS_FILE, 'rustXX\n');
    const res = cli(root, ['plan'], { ...BASE_ENV, CI_WASM_CACHE: 'on', GITHUB_EVENT_NAME: 'pull_request' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /::warning title=WASM build cache off for this run::input 'rustXX' does not exist at HEAD/);
    assert.match(res.stdout, /mode=on\nactive=false\nverify=false\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compare CLI: identical passes; drift fails only with --strict in mode on', () => {
  const root = makeScriptRepo();
  const temp = mkdtempSync(join(tmpdir(), 'wasm-cache-temp-'));
  try {
    fakeBuild(root);
    recordOutputs(root, 'k');
    copyFileSync(join(root, '.ci-wasm-cache/manifest.json'), join(temp, 'wasm-cache-restored.json'));
    const same = cli(root, ['compare', '--strict'], { WASM_CACHE_MODE: 'on', RUNNER_TEMP: temp });
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, /matches the fresh build byte for byte/);

    fakeBuild(root, '-drifted');
    recordOutputs(root, 'k');
    const shadow = cli(root, ['compare', '--strict'], { WASM_CACHE_MODE: 'shadow', RUNNER_TEMP: temp });
    assert.equal(shadow.status, 0);
    assert.match(shadow.stdout, /::warning title=WASM build cache drift::8 file\(s\)/);
    const lenient = cli(root, ['compare'], { WASM_CACHE_MODE: 'on', RUNNER_TEMP: temp });
    assert.equal(lenient.status, 0);
    assert.match(lenient.stdout, /::error title=WASM build cache drift::/);
    const strict = cli(root, ['compare', '--strict'], { WASM_CACHE_MODE: 'on', RUNNER_TEMP: temp });
    assert.equal(strict.status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

test('every entry of the shipped input list names something tracked in this repo', () => {
  const repoRoot = join(HERE, '..');
  for (const entry of readInputList(repoRoot)) {
    const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', entry], { cwd: repoRoot, encoding: 'utf-8' });
    assert.ok(listed.trim().length > 0, `${INPUTS_FILE} entry '${entry}' matches no tracked file`);
  }
});

test('with the shipped list, editing any known build input moves the key', () => {
  // A temp repo shaped like this one at every shipped entry: a blob entry
  // becomes a file, a tree entry a directory holding one file.
  const repoRoot = join(HERE, '..');
  const entries = readInputList(repoRoot);
  const root = mkdtempSync(join(tmpdir(), 'wasm-cache-shipped-'));
  try {
    const fileFor = (entry) => {
      const kind = execFileSync('git', ['cat-file', '-t', `HEAD:${entry}`], { cwd: repoRoot, encoding: 'utf-8' }).trim();
      return kind === 'tree' ? `${entry}/probe` : entry;
    };
    for (const entry of entries) {
      mkdirSync(dirname(join(root, fileFor(entry))), { recursive: true });
      writeFileSync(join(root, fileFor(entry)), 'v1\n');
    }
    git(root, 'init', '-q', '.');
    git(root, 'config', 'user.email', 'harness@example.invalid');
    git(root, 'config', 'user.name', 'harness');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    const key = () => cacheKey(inputManifest({ cwd: root, paths: entries, env: BASE_ENV }), BASE_ENV);
    // Each of these changes the bytes build-wasm.sh writes (see the comments
    // in the list); a list that drops one keeps a stale key here.
    const known = {
      rust: 'rust/probe',
      'Cargo.toml': 'Cargo.toml',
      'Cargo.lock': 'Cargo.lock',
      'rust-toolchain.toml': 'rust-toolchain.toml',
      '.cargo/config.toml': '.cargo/config.toml',
      'scripts/build-wasm.sh': 'scripts/build-wasm.sh',
      'scripts/test-diff-decode-leaks.sh': 'scripts/test-diff-decode-leaks.sh',
      '.github/actions/setup-wasm-build': '.github/actions/setup-wasm-build/action.yml',
    };
    for (const [input, file] of Object.entries(known)) {
      const before = key();
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), `edited ${input}\n`);
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', `edit ${input}`);
      assert.notEqual(key(), before, `editing ${file} must change the key`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
