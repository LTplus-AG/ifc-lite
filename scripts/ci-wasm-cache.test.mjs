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
  inputManifest,
  cacheKey,
  recordOutputs,
  verifyRestored,
  readManifest,
  diffFiles,
  cleanOutputs,
  OUTPUT_DIRS,
  REQUIRED_OUTPUTS,
} from './ci-wasm-cache.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
import { INPUTS_FILE, parseInputEntries, readInputList } from './lib/wasm-build-inputs.mjs';
import { BASE_ENV, REPO_ENV, KEYABLE_WORKFLOW, git, makeRepo, commit, makeScriptRepo } from './lib/ci-wasm-cache-fixture.mjs';

test('only the exact strings `shadow` and `on` leave the cache off', () => {
  for (const raw of ['shadow', 'on']) assert.equal(normalizeMode(raw), raw);
  for (const raw of [undefined, '', 'off', 'ON', 'Shadow', ' on', 'true', '1', 'yes']) {
    assert.equal(normalizeMode(raw), 'off', `${JSON.stringify(raw)}`);
  }
});

test('plan: only an `on` ordinary PR run may skip the build; only main saves', () => {
  const main = 'refs/heads/main';
  const pr = 'refs/pull/7/merge';
  const queue = 'refs/heads/gh-readonly-queue/main/pr-7-abc';
  const rows = [
    // mode, event, batch, ref -> active, verify, store
    ['off', 'pull_request', 'false', pr, false, false, false],
    ['off', 'push', 'false', main, false, false, false],
    ['shadow', 'pull_request', 'false', pr, true, true, false],
    ['shadow', 'push', 'false', main, true, true, true],
    ['on', 'pull_request', 'false', pr, true, false, false],
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

test('the shipped list: the README keys the cache only; the wasm-pack pin also gates the prebuilt bundle', () => {
  // #9793 review. README.md reaches pkg/README.md, which npm does not ship;
  // the setup-wasm-build pin builds the published bundle in release.yml.
  const repoRoot = join(HERE, '..');
  const all = readInputList(repoRoot);
  const published = readInputList(repoRoot, { published: true });
  assert.ok(all.includes('README.md') && !published.includes('README.md'));
  assert.ok(published.includes('.github/actions/setup-wasm-build'));
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
      // #9793 second-round review: every family that can swap the compiler,
      // its flags or the C toolchain moves the key.
      { ...BASE_ENV, CARGO_BUILD_RUSTC: '/opt/other/rustc' },
      { ...BASE_ENV, CARGO_BUILD_RUSTC_WRAPPER: 'sccache' },
      { ...BASE_ENV, CARGO_BUILD_RUSTFLAGS: '-C opt-level=1' },
      { ...BASE_ENV, CARGO_ENCODED_RUSTFLAGS: '-Copt-level=1' },
      { ...BASE_ENV, CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: '-C opt-level=1' },
      { ...BASE_ENV, CARGO_SOURCE_CRATES_IO_REPLACE_WITH: 'mirror' },
      { ...BASE_ENV, RUSTC_LINKER: 'lld' },
      { ...BASE_ENV, RUSTC_WORKSPACE_WRAPPER: 'w' },
      { ...BASE_ENV, RUSTDOCFLAGS: '-x' },
      { ...BASE_ENV, WASM_BINDGEN_EXTERNREF: '1' },
      { ...BASE_ENV, WASM_PACK_CACHE: '/tmp/x' },
      { ...BASE_ENV, CC: 'clang' },
      { ...BASE_ENV, CC_wasm32_unknown_unknown: 'clang' },
      { ...BASE_ENV, CFLAGS_wasm32_unknown_unknown: '-O1' },
      { ...BASE_ENV, TARGET_CFLAGS: '-O1' },
      { ...BASE_ENV, HOME: '/home/other' },
      { ...BASE_ENV, RUNNER_ARCH: 'ARM64' },
      { ...BASE_ENV, DEBUG_GEOMETRY: '' },
    ]) {
      assert.notEqual(keyOf(root, env), now, JSON.stringify(env));
    }
    assert.equal(
      keyOf(root, { ...BASE_ENV, PATH: '/elsewhere', GITHUB_SHA: 'abc', CARGO_REGISTRY_TOKEN: 't', CARGO_BUILD_SECRET: 's' }),
      now,
      'unrelated env and credential-named vars must not change (or enter) the key',
    );
    // A file newly committed under an output dir is part of every fresh build
    // (clean restores it), so it must start a new entry rather than make the
    // old one fail verification on every restore.
    mkdirSync(join(root, 'packages/wasm/pkg-diff'), { recursive: true });
    commit(root, 'packages/wasm/pkg-diff/extra.d.ts', 'committed\n');
    assert.notEqual(keyOf(root), now, 'a newly tracked output file must change the key');
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
    // #9793 review: the JS entrypoint the decode-leak test imports.
    fakeBuild(root);
    rmSync(join(root, 'packages/wasm/pkg-diff-decode-test/ifc-lite-diff.js'));
    assert.throws(() => recordOutputs(root, 'k'), /missing packages\/wasm\/pkg-diff-decode-test\/ifc-lite-diff\.js/);
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

/**
 * Run the CLI with no $GITHUB_OUTPUT (local mode): outputs and annotations
 * both on stdout. The file-based wiring is ci-wasm-cache.wiring.test.mjs.
 */
function cli(root, args, env) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'ci-wasm-cache.mjs'), ...args], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, ...REPO_ENV, ...env },
  });
}

/** `name=value` lines of a local-mode run, with `::` annotation lines left out. */
function outputsOf(stdout) {
  const out = {};
  for (const line of stdout.split('\n')) {
    const pair = line.match(/^(\w+)=(.*)$/);
    if (pair) out[pair[1]] = pair[2];
  }
  return out;
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
    assert.match(plan.stdout, /^mode=on\nactive=true\nverify=false\nstore=false\n/);
    assert.match(plan.stdout, /paths<<__WASM_CACHE_EOF__\npackages\/wasm\/pkg\n[\s\S]*\.ci-wasm-cache\n__WASM_CACHE_EOF__\n$/);

    fakeBuild(root);
    const record = cli(root, ['record'], { ...env, WASM_CACHE_KEY: key });
    assert.equal(record.status, 0, record.stdout + record.stderr);

    const resolveEnv = { WASM_CACHE_MODE: 'on', WASM_CACHE_VERIFY: 'false', WASM_CACHE_STORE: 'true', WASM_CACHE_HIT: 'true', WASM_CACHE_KEY: key, RUNNER_TEMP: temp };
    const hit = cli(root, ['resolve'], resolveEnv);
    assert.equal(hit.stdout, 'build=false\ncompare=false\nsave=false\nrejected=false\n', hit.stderr);

    writeFileSync(join(root, 'packages/wasm/pkg/ifc-lite.js'), 'tampered');
    const tampered = cli(root, ['resolve'], resolveEnv);
    assert.deepEqual(outputsOf(tampered.stdout), { build: 'true', compare: 'false', save: 'false', rejected: 'true' });
    assert.match(tampered.stdout, /^::warning title=WASM build cache entry rejected::/m);
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
    assert.deepEqual(outputsOf(res.stdout), { mode: 'on', active: 'false', verify: 'false' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('record refuses a build whose env moved after Plan keyed it, except rust-cache\'s CARGO_INCREMENTAL=0', () => {
  const root = makeScriptRepo();
  const temp = mkdtempSync(join(tmpdir(), 'wasm-cache-temp-'));
  try {
    const env = { ...BASE_ENV, CI_WASM_CACHE: 'on', GITHUB_EVENT_NAME: 'pull_request', RUNNER_TEMP: temp };
    const key = outputsOf(cli(root, ['plan'], env).stdout).key;
    assert.ok(key);
    fakeBuild(root);
    // What Swatinem/rust-cache exports after Plan: tolerated.
    const tolerated = cli(root, ['record'], { ...env, CARGO_INCREMENTAL: '0', WASM_CACHE_KEY: key });
    assert.equal(tolerated.status, 0, tolerated.stdout + tolerated.stderr);
    // A $GITHUB_ENV write between Plan and the build: refused.
    // A job-level compiler swap that appears only after Plan: refused too.
    const swapped = cli(root, ['record'], { ...env, CARGO_BUILD_RUSTC: '/opt/other/rustc', WASM_CACHE_KEY: key });
    assert.equal(swapped.status, 1);
    assert.match(swapped.stdout, /env CARGO_BUILD_RUSTC unset -> env CARGO_BUILD_RUSTC="\/opt\/other\/rustc"/);
    const drifted = cli(root, ['record'], { ...env, RUSTFLAGS: '-C opt-level=1', WASM_CACHE_KEY: key });
    assert.equal(drifted.status, 1);
    assert.match(drifted.stdout, /::warning title=WASM build cache entry not recorded::build env differs from what Plan keyed: env RUSTFLAGS unset -> env RUSTFLAGS="-C opt-level=1"/);
    // A multi-line value stays one line in the snapshot and reads as drift,
    // not as a parse crash.
    const multiline = cli(root, ['record'], { ...env, RUSTFLAGS: 'a\nb', WASM_CACHE_KEY: key });
    assert.equal(multiline.status, 1);
    assert.match(multiline.stdout, /env RUSTFLAGS unset -> env RUSTFLAGS="a\\nb"/);
    const { HOME: _home, ...withoutHome } = env;
    const removed = cli(root, ['record'], { ...withoutHome, WASM_CACHE_KEY: key });
    assert.equal(removed.status, 1, 'a var Plan saw that is gone is drift too');
    // No Plan snapshot at all: refused rather than recorded unchecked.
    const noPlan = cli(root, ['record'], { ...env, RUNNER_TEMP: mkdtempSync(join(tmpdir(), 'wasm-cache-empty-')), WASM_CACHE_KEY: key });
    assert.equal(noPlan.status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

test('plan turns the cache off when the build step adds env, an inline assignment or another command', () => {
  const root = makeScriptRepo();
  const env = { ...BASE_ENV, CI_WASM_CACHE: 'on', GITHUB_EVENT_NAME: 'pull_request' };
  try {
    assert.equal(outputsOf(cli(root, ['plan'], env).stdout).active, 'true', 'the stub workflow is keyable');
    const variants = {
      'sets `env:`': KEYABLE_WORKFLOW.replace('        run: bash', "        env:\n          DEBUG_GEOMETRY: '1'\n        run: bash"),
      'runs `DEBUG_GEOMETRY=1 bash': KEYABLE_WORKFLOW.replace('run: bash', 'run: DEBUG_GEOMETRY=1 bash'),
      'runs `|`': KEYABLE_WORKFLOW.replace('run: bash scripts/ci-wasm-build.sh', 'run: |\n          export RUSTFLAGS=-Cx\n          bash scripts/ci-wasm-build.sh'),
      'runs `bash scripts/ci-wasm-build.sh && bash scripts/build-wasm.sh`': KEYABLE_WORKFLOW.replace('ci-wasm-build.sh', 'ci-wasm-build.sh && bash scripts/build-wasm.sh'),
      'no step runs': KEYABLE_WORKFLOW.replace('scripts/ci-wasm-build.sh', 'scripts/build-wasm.sh'),
      'sets `"env": {RUSTFLAGS': KEYABLE_WORKFLOW.replace('        run: bash', '        "env": {RUSTFLAGS: "-C opt-level=1"}\n        run: bash'),
    };
    for (const [problem, workflow] of Object.entries(variants)) {
      commit(root, '.github/workflows/test.yml', workflow);
      const res = cli(root, ['plan'], env);
      assert.equal(outputsOf(res.stdout).active, 'false', problem);
      assert.match(res.stdout, /::warning title=WASM build cache off for this run::the WASM build step is not keyable/);
      assert.ok(res.stdout.includes(problem), `${problem} not named in: ${res.stdout}`);
    }
    // A branch name may contain `@`; the workflow path is cut at the first one.
    commit(root, '.github/workflows/test.yml', KEYABLE_WORKFLOW);
    const atBranch = cli(root, ['plan'], { ...env, GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/test.yml@refs/heads/fix@cache' });
    assert.equal(outputsOf(atBranch.stdout).active, 'true', atBranch.stdout);
    const missing = cli(root, ['plan'], { ...env, GITHUB_WORKFLOW_REF: '' });
    assert.equal(outputsOf(missing.stdout).active, 'false', 'no workflow ref: cannot check, so off');
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
    assert.match(shadow.stdout, /::warning title=WASM build cache drift::11 file\(s\)/);
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
      // #9793 review: wasm-pack copies the root README into pkg/.
      'README.md': 'README.md',
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
