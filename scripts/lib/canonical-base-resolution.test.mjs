/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6950: every script that judges a branch against "main" must resolve that
 * main through `canonical-remote.mjs`, not through a hard-coded `origin/main`.
 * On a contributor machine `origin` is often a stale fork and the canonical
 * repository is `upstream`; on CI `origin` IS the canonical repository.
 *
 * Each case builds a throwaway repository in a temp dir with two remotes and
 * two diverged mains: the fork's `origin/main` is one commit BEHIND the
 * canonical `upstream/main`. A branch sitting on the canonical tip is then
 * clean against `upstream/main` and carries an apparent change against the
 * fork's main. The second layout (canonical `origin` only) pins that the
 * resolved ref string is exactly what it was before this change.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalMainRef, canonicalMainRefIn } from './canonical-remote.mjs';
import { changedFiles, changedFilesWarned, resolveBase } from './module-size-git.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORK_URL = 'https://github.com/BIMvoice/ifc-lite.git';
const CANONICAL_URL = 'https://github.com/LTplus-AG/ifc-lite.git';

const RAW_READ = 'function query(m) { for (const row of m.store.entityIndex.byType) use(row); }\n';
const EXAMPLE = 'packages/mcp/src/tools/example.ts';
const VIEWER = 'apps/viewer/src/main.ts';

const cleanup = [];
process.on('exit', () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'canonical-base-'));
  cleanup.push(dir);
  const git = (...args) => {
    const res = spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      },
    });
    assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  };
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  return { dir, git, write };
}

/**
 * `older` is the first commit, `newer` the second (it adds a raw entity read).
 * `layout` 'fork-origin' puts the fork on `origin` at `older` and the canonical
 * repository on `upstream` at `newer`; 'canonical-origin' has only `origin`,
 * canonical, at `newer`; 'fork-only' has only a fork `origin` at `older`.
 * The branch under test sits on `newer` with no change of its own.
 */
function makeLayout(layout) {
  const repo = makeRepo();
  const { git, write } = repo;
  git('init', '-q', '-b', 'main');
  write(EXAMPLE, 'export const x = 1;\n');
  write(VIEWER, 'export const y = 1;\n');
  write('scripts/raw-entity-enumeration-reviewed-files.txt', '# none\n');
  git('add', '-A');
  git('commit', '-qm', 'older');
  const older = git('rev-parse', 'HEAD');
  write(EXAMPLE, RAW_READ);
  git('commit', '-qam', 'newer');
  const newer = git('rev-parse', 'HEAD');
  if (layout === 'fork-origin') {
    git('remote', 'add', 'origin', FORK_URL);
    git('remote', 'add', 'upstream', CANONICAL_URL);
    git('update-ref', 'refs/remotes/origin/main', older);
    git('update-ref', 'refs/remotes/upstream/main', newer);
  } else if (layout === 'canonical-origin') {
    git('remote', 'add', 'origin', CANONICAL_URL);
    git('update-ref', 'refs/remotes/origin/main', newer);
  } else if (layout === 'upstream-never-fetched') {
    git('remote', 'add', 'origin', FORK_URL);
    git('remote', 'add', 'upstream', CANONICAL_URL);
    git('update-ref', 'refs/remotes/origin/main', older);
  } else {
    git('remote', 'add', 'origin', FORK_URL);
    git('update-ref', 'refs/remotes/origin/main', older);
  }
  git('checkout', '-q', '-b', 'feature');
  // No local `main` fallback to hide behind, except where the case is the fallback.
  if (layout !== 'upstream-never-fetched') git('branch', '-q', '-D', 'main');
  return { ...repo, older, newer };
}

test('canonicalMainRef: canonical upstream wins over a fork origin; canonical origin and no remotes keep origin/main (#6950)', () => {
  const remote = (name, url) => `${name}\t${url} (fetch)\n${name}\t${url} (push)\n`;
  assert.equal(canonicalMainRef(remote('origin', FORK_URL) + remote('upstream', CANONICAL_URL)), 'upstream/main');
  assert.equal(canonicalMainRef(remote('origin', CANONICAL_URL)), 'origin/main');
  assert.equal(canonicalMainRef(remote('origin', CANONICAL_URL) + remote('upstream', CANONICAL_URL)), 'origin/main');
  assert.equal(canonicalMainRef(remote('origin', FORK_URL)), 'origin/main');
  assert.equal(canonicalMainRef(''), 'origin/main');
});

test('canonicalMainRefIn reads the repository it is given, and a non-repository gives origin/main (#6950)', () => {
  assert.equal(canonicalMainRefIn(makeLayout('fork-origin').dir), 'upstream/main');
  assert.equal(canonicalMainRefIn(makeLayout('canonical-origin').dir), 'origin/main');
  assert.equal(canonicalMainRefIn(makeLayout('fork-only').dir), 'origin/main');
  const notARepo = mkdtempSync(join(tmpdir(), 'canonical-base-none-'));
  cleanup.push(notARepo);
  assert.equal(canonicalMainRefIn(notARepo), 'origin/main');
});

test('module-size-git resolveBase: a fork origin does not outrank the canonical upstream (#6950)', () => {
  const { dir, newer } = makeLayout('fork-origin');
  const base = resolveBase(dir);
  assert.deepEqual(base, { ref: 'upstream/main', sha: newer, fellBack: false });
  assert.deepEqual([...changedFiles(dir).changed], []);
});

test('module-size-git resolveBase: with a canonical origin the ref string is the one it always was (#6950)', () => {
  const { dir, newer } = makeLayout('canonical-origin');
  assert.deepEqual(resolveBase(dir), { ref: 'origin/main', sha: newer, fellBack: false });
});

test('module-size-git resolveBase: an explicit ref is used as given, whatever the remotes are (#6950)', () => {
  const { dir, older } = makeLayout('fork-origin');
  assert.deepEqual(resolveBase(dir, { ref: 'origin/main' }), { ref: 'origin/main', sha: older, fellBack: false });
  assert.deepEqual(resolveBase(dir, { ref: 'nope/main' }), { error: 'no merge base with nope/main' });
});

test('module-size-git: a canonical upstream that was never fetched falls back to local main, and the warning names upstream/main (#6950)', () => {
  const { dir, newer } = makeLayout('upstream-never-fetched');
  assert.deepEqual(resolveBase(dir), { ref: 'main', sha: newer, fellBack: true, wanted: 'upstream/main' });
  const warnings = [];
  changedFilesWarned(dir, null, (message) => warnings.push(message));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no merge base with upstream\/main; fell back to local 'main'/);
  assert.match(warnings[0], /Fetch upstream\/main and re-run/);
  assert.doesNotMatch(warnings[0], /origin\/main/);
});

/**
 * The source at `path` with each relative import repointed at the real sibling
 * file, so a copy placed in a throwaway repository can run. A `required`
 * specifier the source no longer imports throws; an `optional` one is skipped
 * so the unchanged-behaviour cases can also run against the pre-#6950 file,
 * which does not import `canonical-remote.mjs`.
 */
function relocate(path, required, optional, siblingsDir) {
  let source = readFileSync(path, 'utf8');
  for (const specifier of [...required, ...optional]) {
    const needle = `from '${specifier}'`;
    const rewritten = source.replace(needle, `from ${JSON.stringify(pathToFileURL(join(siblingsDir, specifier)).href)}`);
    if (rewritten === source && required.includes(specifier)) throw new Error(`${path} no longer imports ${specifier}`);
    source = rewritten;
  }
  return source;
}

/** Run a copy of check-raw-entity-enumeration.mjs rooted at `dir`, its sibling imports made absolute. */
function runRawEntityGate(dir) {
  const source = relocate(join(SCRIPTS, 'check-raw-entity-enumeration.mjs'), ['./lib/raw-entity-enumeration.mjs'], ['./lib/canonical-remote.mjs'], SCRIPTS);
  const copy = join(dir, 'scripts', 'check-raw-entity-enumeration.mjs');
  writeFileSync(copy, source);
  const res = spawnSync(process.execPath, [copy], { cwd: dir, encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

test('check-raw-entity-enumeration: a fork origin does not make main\'s own raw read look new (#6950)', () => {
  const { dir } = makeLayout('fork-origin');
  const { code, out } = runRawEntityGate(dir);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /NEW raw entity access/);
});

test('check-raw-entity-enumeration: with a canonical origin the verdict is unchanged (#6950)', () => {
  const { dir } = makeLayout('canonical-origin');
  const { code, out } = runRawEntityGate(dir);
  assert.equal(code, 0, out);
});

test('check-raw-entity-enumeration: with no canonical remote it still judges against origin/main and can fail (#6950)', () => {
  // Control for the two cases above: the gate is not vacuous, and the
  // no-canonical-remote default is still `origin/main` (here a base without
  // the raw read, so the read is a new site).
  const { dir } = makeLayout('fork-only');
  const { code, out } = runRawEntityGate(dir);
  assert.equal(code, 1, out);
  assert.match(out, /NEW raw entity access/);
});

/** `resolveMainTip` from a copy of base-freshness-io.mjs rooted at `dir`, with a `gh` that reports `remoteSha` as main. */
async function resolveTipIn(dir, remoteSha) {
  const source = relocate(join(SCRIPTS, 'lib', 'base-freshness-io.mjs'), ['./gh.mjs', './base-freshness.mjs'], ['./canonical-remote.mjs'], join(SCRIPTS, 'lib'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  const copy = join(dir, 'scripts', 'lib', 'base-freshness-io.mjs');
  writeFileSync(copy, source);
  const bin = join(dir, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho '{"sha":"${remoteSha}"}'\n`);
  chmodSync(join(bin, 'gh'), 0o755);

  const { resolveMainTip } = await import(pathToFileURL(copy).href);
  const realExit = process.exit;
  const realError = console.error;
  const realPath = process.env.PATH;
  const stderr = [];
  process.env.PATH = `${bin}:${realPath}`;
  console.error = (...args) => stderr.push(args.join(' '));
  process.exit = (code) => { throw new Error(`exit ${code}`); };
  try {
    return { tip: resolveMainTip('LTplus-AG/ifc-lite'), stderr: stderr.join('\n') };
  } catch (error) {
    return { exit: error.message, stderr: stderr.join('\n') };
  } finally {
    process.exit = realExit;
    console.error = realError;
    process.env.PATH = realPath;
  }
}

test('base-freshness resolveMainTip: measures against the canonical remote\'s main, not a fork origin (#6950)', async () => {
  const { dir, newer } = makeLayout('fork-origin');
  const result = await resolveTipIn(dir, newer);
  assert.equal(result.tip, newer, `${result.exit ?? ''} ${result.stderr}`);
});

test('base-freshness resolveMainTip: with a canonical origin it reads refs/remotes/origin/main as before (#6950)', async () => {
  const { dir, newer } = makeLayout('canonical-origin');
  const result = await resolveTipIn(dir, newer);
  assert.equal(result.tip, newer, `${result.exit ?? ''} ${result.stderr}`);
});

test('base-freshness resolveMainTip: a stale canonical main is refused, and the remedy names the remote to fetch (#6950)', async () => {
  const { dir, older, newer } = makeLayout('fork-origin');
  const result = await resolveTipIn(dir, older);
  assert.equal(result.exit, 'exit 2');
  assert.match(result.stderr, /Run `git fetch upstream main` and try again\./);
  assert.notEqual(older, newer);
});

test('canonical-main-ref.mjs (what perf/ab.sh runs) prints the canonical main, and origin/main with a canonical origin (#6950)', () => {
  const cli = join(SCRIPTS, 'lib', 'canonical-main-ref.mjs');
  const printed = (layout) => spawnSync(process.execPath, [cli], { cwd: makeLayout(layout).dir, encoding: 'utf8' }).stdout;
  assert.equal(printed('fork-origin'), 'upstream/main\n');
  assert.equal(printed('canonical-origin'), 'origin/main\n');
  assert.equal(printed('fork-only'), 'origin/main\n');
});
