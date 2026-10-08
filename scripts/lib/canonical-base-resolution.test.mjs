/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7031: the PRODUCTION callers that judge a branch against "main" resolve
 * that main through the canonical remote, not through a hard-coded
 * `origin/main`. This file drives the callers, each in a throwaway repository
 * with real remotes, and (last section) the URL matcher through one of them:
 *
 *   - module-size-git `resolveBase` / `changedFiles` / `changedFilesWarned`
 *     (what check-module-size and check-source-text-assertions resolve with);
 *   - check-raw-entity-enumeration.mjs, run as a script;
 *   - base-freshness-io `resolveMainTip`;
 *   - perf/ab.sh, run as a shell script up to `--print-base`.
 *
 * Layouts. Two commits, `older` then `newer` (`newer` adds a raw entity read).
 * The branch under test sits on `newer` with no change of its own, so it is
 * clean against a main at `newer` and carries an apparent change against a
 * main at `older`.
 *
 *   fork-origin        origin = a fork at `older`; upstream = canonical at `newer`
 *   canonical-origin   origin = canonical at `newer` (an Actions checkout)
 *   no-canonical       origin = a fork at `older`, nothing else
 *   unfetched          origin = a fork at `older`; upstream = canonical, never fetched;
 *                      a local `main` at `newer` remains as the fallback
 *
 * Every case enters through an export or a script that exists on main, so
 * each fails by assertion, not at import, when the production change is
 * reverted.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { changedFiles, changedFilesWarned, resolveBase } from './module-size-git.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORK_URL = 'https://github.com/some-fork/ifc-lite.git';
const CANONICAL_URL = 'https://github.com/LTplus-AG/ifc-lite.git';

const RAW_READ = 'function query(m) { for (const row of m.store.entityIndex.byType) use(row); }\n';
const EXAMPLE = 'packages/mcp/src/tools/example.ts';
const VIEWER = 'apps/viewer/src/main.ts';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};

const cleanup = [];
process.on('exit', () => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function makeLayout(layout) {
  const dir = mkdtempSync(join(tmpdir(), 'canonical-base-'));
  cleanup.push(dir);
  const git = (...args) => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  };
  const write = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
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
  git('remote', 'add', 'origin', layout === 'canonical-origin' ? CANONICAL_URL : FORK_URL);
  git('update-ref', 'refs/remotes/origin/main', layout === 'canonical-origin' ? newer : older);
  if (layout === 'fork-origin' || layout === 'unfetched') git('remote', 'add', 'upstream', CANONICAL_URL);
  if (layout === 'fork-origin') git('update-ref', 'refs/remotes/upstream/main', newer);
  git('checkout', '-q', '-b', 'feature');
  // No local `main` to fall back on, except where the fallback is the case.
  if (layout !== 'unfetched') git('branch', '-q', '-D', 'main');
  return { dir, git, write, older, newer };
}

// --- module-size-git: check-module-size and check-source-text-assertions ----

test('resolveBase, fork-origin: the canonical upstream is the base, not the fork origin (#7031)', () => {
  const { dir, newer } = makeLayout('fork-origin');
  const base = resolveBase(dir);
  assert.equal(base.ref, 'upstream/main');
  assert.equal(base.sha, newer);
  assert.equal(base.fellBack, false);
  assert.deepEqual([...changedFiles(dir).changed], [], 'a branch sitting on the canonical main has changed nothing');
});

test('resolveBase, canonical-origin: the ref is the string origin/main, as before (#7031)', () => {
  const { dir, newer } = makeLayout('canonical-origin');
  assert.deepEqual(resolveBase(dir), { ref: 'origin/main', sha: newer, fellBack: false });
});

test('resolveBase, explicit-base: the ref is used as given, whatever the remotes are (#7031)', () => {
  const { dir, older } = makeLayout('fork-origin');
  assert.deepEqual(resolveBase(dir, { ref: 'origin/main' }), { ref: 'origin/main', sha: older, fellBack: false });
  assert.deepEqual(resolveBase(dir, { ref: 'nope/main' }), { error: 'no merge base with nope/main' });
});

test('resolveBase, no-canonical-remote: origin/main stays the default and is not a fallback (#7031)', () => {
  const { dir, older } = makeLayout('no-canonical');
  assert.deepEqual(resolveBase(dir), { ref: 'origin/main', sha: older, fellBack: false });
});

test('resolveBase, unfetched-ref: falls back to local main and the warning names the ref to fetch (#7031)', () => {
  const { dir, newer } = makeLayout('unfetched');
  const base = resolveBase(dir);
  assert.equal(base.ref, 'main');
  assert.equal(base.sha, newer);
  assert.equal(base.fellBack, true);
  const warnings = [];
  changedFilesWarned(dir, null, (message) => warnings.push(message));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no merge base with upstream\/main; fell back to local 'main'/);
  assert.match(warnings[0], /Fetch upstream\/main and re-run/);
  assert.doesNotMatch(warnings[0], /origin\/main/, 'the remedy must not send the contributor to fetch the fork');
});

// --- check-raw-entity-enumeration.mjs, run as a script ----------------------

/**
 * The scripts under test, copied into the throwaway repository at their real
 * relative paths, so each one locates ITS repository (the fixture) the way it
 * locates the real one. `scripts/lib` is copied whole, minus its tests, so the
 * same call serves the tree before and after #7031 (the lib then simply lacks
 * the canonical-remote files). `node_modules` is linked for the one bare
 * import among them (`typescript`).
 */
function installScripts(dir) {
  cpSync(join(SCRIPTS, 'lib'), join(dir, 'scripts', 'lib'), { recursive: true, filter: (source) => !source.endsWith('.test.mjs') });
  mkdirSync(join(dir, 'scripts', 'perf'), { recursive: true });
  copyFileSync(join(SCRIPTS, 'check-raw-entity-enumeration.mjs'), join(dir, 'scripts', 'check-raw-entity-enumeration.mjs'));
  copyFileSync(join(SCRIPTS, 'perf', 'ab.sh'), join(dir, 'scripts', 'perf', 'ab.sh'));
  chmodSync(join(dir, 'scripts', 'perf', 'ab.sh'), 0o755);
  symlinkSync(join(SCRIPTS, '..', 'node_modules'), join(dir, 'node_modules'), 'dir');
}

function runRawEntityGate(dir) {
  installScripts(dir);
  const copy = join(dir, 'scripts', 'check-raw-entity-enumeration.mjs');
  const res = spawnSync(process.execPath, [copy], { cwd: dir, encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

test("check-raw-entity-enumeration, fork-origin: main's own raw read is not reported as new (#7031)", () => {
  const { code, out } = runRawEntityGate(makeLayout('fork-origin').dir);
  assert.doesNotMatch(out, /NEW raw entity access/);
  assert.equal(code, 0, out);
});

test('check-raw-entity-enumeration, canonical-origin: the verdict is unchanged (#7031)', () => {
  const { code, out } = runRawEntityGate(makeLayout('canonical-origin').dir);
  assert.equal(code, 0, out);
});

test('check-raw-entity-enumeration, no-canonical-remote: still judged against origin/main, and it can fail (#7031)', () => {
  // The control for the two cases above: the gate is not vacuous in this
  // fixture. origin/main is `older`, which lacks the raw read, so the read is new.
  const { code, out } = runRawEntityGate(makeLayout('no-canonical').dir);
  assert.match(out, /NEW raw entity access/);
  assert.equal(code, 1, out);
});

test('check-raw-entity-enumeration, unfetched-ref: fails on the missing canonical main instead of judging against the fork (#7031)', () => {
  // The gate has no fallback: with upstream/main unfetched there is no merge
  // base to take, and the failure names the ref. It must NOT quietly judge
  // against the fork's origin/main and report main's own read as new.
  const { code, out } = runRawEntityGate(makeLayout('unfetched').dir);
  assert.doesNotMatch(out, /NEW raw entity access/);
  assert.match(out, /upstream\/main/);
  assert.notEqual(code, 0, out);
});

// --- base-freshness-io resolveMainTip ---------------------------------------

/** `resolveMainTip` from a copy of base-freshness-io.mjs rooted at `dir`, with a `gh` on PATH that reports `remoteSha` as main. */
async function resolveTipIn(dir, remoteSha) {
  installScripts(dir);
  const copy = join(dir, 'scripts', 'lib', 'base-freshness-io.mjs');
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
  process.exit = (code) => {
    throw new Error(`exit ${code}`);
  };
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

test('resolveMainTip, unfetched-ref: falls back to HEAD, and accepts it only because it is the main GitHub reports (#7031)', async () => {
  // upstream/main was never fetched, so the tip comes from HEAD (`newer`). The
  // fork's origin/main (`older`) must not be used: it is not GitHub's main.
  const { dir, newer, older } = makeLayout('unfetched');
  const accepted = await resolveTipIn(dir, newer);
  assert.equal(accepted.tip, newer, `${accepted.exit ?? ''} ${accepted.stderr}`);
  const refused = await resolveTipIn(makeLayout('unfetched').dir, older);
  assert.equal(refused.exit, 'exit 2', refused.stderr);
});

test("resolveMainTip, fork-origin: measures against the canonical remote's main (#7031)", async () => {
  const { dir, newer } = makeLayout('fork-origin');
  const result = await resolveTipIn(dir, newer);
  assert.equal(result.tip, newer, `${result.exit ?? ''} ${result.stderr}`);
});

test('resolveMainTip, canonical-origin: reads refs/remotes/origin/main as before (#7031)', async () => {
  const { dir, newer } = makeLayout('canonical-origin');
  const result = await resolveTipIn(dir, newer);
  assert.equal(result.tip, newer, `${result.exit ?? ''} ${result.stderr}`);
});

test('resolveMainTip, fork-origin with a stale canonical ref: refused, and the remedy names the remote to fetch (#7031)', async () => {
  // GitHub says main is at a commit this clone's upstream/main is not at.
  const { dir, git, newer } = makeLayout('fork-origin');
  const ahead = git('commit-tree', '-m', 'ahead', '-p', newer, `${newer}^{tree}`);
  const result = await resolveTipIn(dir, ahead);
  assert.equal(result.exit, 'exit 2', result.stderr);
  assert.match(result.stderr, /Run `git fetch upstream main` and try again\./);
});

// --- perf/ab.sh: the shell wiring -------------------------------------------

function abPrintBase(layout, extra = []) {
  const repo = makeLayout(layout);
  installScripts(repo.dir);
  // HOME points into the fixture so ab.sh's `source ~/.cargo/env` finds nothing to run.
  const res = spawnSync('bash', [join(repo.dir, 'scripts', 'perf', 'ab.sh'), EXAMPLE, '--print-base', ...extra], {
    cwd: repo.dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, HOME: repo.dir },
  });
  return { ...repo, code: res.status, stdout: res.stdout.trim(), stderr: res.stderr };
}

test('perf/ab.sh, fork-origin: the default base is the merge base with the canonical main (#7031)', () => {
  const run = abPrintBase('fork-origin');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, run.newer);
});

test('perf/ab.sh, canonical-origin: the default base is the merge base with origin/main, as before (#7031)', () => {
  const run = abPrintBase('canonical-origin');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, run.newer);
});

test('perf/ab.sh, no-canonical-remote: the default base is still the merge base with origin/main (#7031)', () => {
  const run = abPrintBase('no-canonical');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, run.older);
});

test('perf/ab.sh, explicit-base: --base is used as given (#7031)', () => {
  const run = abPrintBase('fork-origin', ['--base', 'origin/main']);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, 'origin/main');
});

test('perf/ab.sh, unfetched-ref: with no canonical main fetched it falls back to HEAD~1, as it did for a missing origin/main (#7031)', () => {
  const run = abPrintBase('unfetched');
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, run.older, 'HEAD~1 of the feature branch is `older`');
});

// --- which remote counts as canonical ---------------------------------------
//
// The URL matcher in canonical-remote.mjs, exercised through `resolveBase` on
// repositories that really have these remotes, so what is asserted is what git
// reports for them and what a caller then gets.

/**
 * The base ref `resolveBase` picks in a one-commit repository with the given
 * remotes, each `[name, fetchUrl, pushUrl?]`, every one of them with a fetched
 * `main`, and no local `main` to fall back on.
 */
function baseRefWith(remotes) {
  const dir = mkdtempSync(join(tmpdir(), 'canonical-remote-'));
  cleanup.push(dir);
  const git = (...args) => {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'only');
  const sha = git('rev-parse', 'HEAD');
  for (const [name, fetchUrl, pushUrl] of remotes) {
    git('remote', 'add', name, fetchUrl);
    if (pushUrl) git('remote', 'set-url', '--push', name, pushUrl);
    git('update-ref', `refs/remotes/${name}/main`, sha);
  }
  git('checkout', '-q', '-b', 'feature');
  git('branch', '-q', '-D', 'main');
  return resolveBase(dir).ref;
}

test('the canonical repository is recognised under another remote name in https, scp-style and ssh:// forms (#7031)', () => {
  for (const url of [
    'https://github.com/LTplus-AG/ifc-lite.git',
    'https://github.com/LTplus-AG/ifc-lite',
    'https://github.com/LTplus-AG/ifc-lite/',
    'git@github.com:LTplus-AG/ifc-lite.git',
    'ssh://git@github.com/LTplus-AG/ifc-lite',
    'https://x-access-token:abc@github.com/LTplus-AG/ifc-lite',
    'https://github.com/ltplus-ag/ifc-lite.git',
    'ssh://git@ssh.github.com:443/LTplus-AG/ifc-lite.git',
  ]) {
    assert.equal(baseRefWith([['origin', FORK_URL], ['upstream', url]]), 'upstream/main', url);
  }
});

test('a fork, a sibling repository and a path that merely contains the name are not the canonical repository (#7031)', () => {
  for (const url of [
    'https://github.com/another-fork/ifc-lite.git',
    'https://github.com/LTplus-AG/ifc-lite-fork.git',
    'https://github.com/Evil-LTplus-AG/ifc-lite.git',
    'https://github.com/some-fork/LTplus-AG/ifc-lite.git',
    'git@github.com:some-fork/LTplus-AG/ifc-lite.git',
    // The same path on another host (a stale mirror) is not the canonical repository (#7031 review).
    'https://gitlab.com/LTplus-AG/ifc-lite.git',
    'git@gitlab.com:LTplus-AG/ifc-lite.git',
    'https://github.com.example.net/LTplus-AG/ifc-lite.git',
    'https://example.net/github.com/LTplus-AG/ifc-lite.git',
  ]) {
    assert.equal(baseRefWith([['origin', FORK_URL], ['upstream', url]]), 'origin/main', url);
  }
});

test('when several remotes are canonical, origin wins wherever git lists it; otherwise the first listed (#7031)', () => {
  // `git remote -v` lists alphabetically: `canon` comes before `origin`.
  assert.equal(baseRefWith([['canon', CANONICAL_URL], ['origin', CANONICAL_URL]]), 'origin/main');
  assert.equal(baseRefWith([['origin', FORK_URL], ['canon', CANONICAL_URL], ['upstream', CANONICAL_URL]]), 'canon/main');
});

test('only a fetch URL counts: a remote that merely pushes to the canonical repository is not read from it (#7031)', () => {
  assert.equal(baseRefWith([['origin', FORK_URL], ['upstream', FORK_URL, CANONICAL_URL]]), 'origin/main');
});

// #7031: a same-path mirror cannot outrank the actual GitHub repository.
test('a mirror on another host is not canonical even when named origin (#7031)', () => {
  for (const url of [
    'https://gitlab.com/LTplus-AG/ifc-lite.git',
    'git@gitlab.com:LTplus-AG/ifc-lite.git',
    'ssh://git@gitlab.com/LTplus-AG/ifc-lite.git',
    'https://github.com.evil.example/LTplus-AG/ifc-lite.git',
    'https://github.com@evil.example/LTplus-AG/ifc-lite.git',
  ]) assert.equal(baseRefWith([['origin', url], ['upstream', CANONICAL_URL]]), 'upstream/main', url);
});
