/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for scripts/check-silent-revert.mjs (incident: #8377 reverted 14 files
 * of #8360 without a word in either title).
 *
 * Two layers. The rules are asserted on literal blob maps (no git). The CLI is
 * then driven against real throwaway repositories built to the incident's
 * SHAPE: the reverted commit sits BELOW the PR's merge base, because that is
 * what #8360 did and what a merge-base-only check cannot see. Every rule is
 * pinned in both directions (flagged / passes), because a guard that only ever
 * fails and one that only ever passes look identical from a green CI run.
 *
 * The last block replays the real history and SKIPS when the objects are
 * absent (a shallow checkout): the `silent-revert` lane has full history and
 * runs it for real.
 *
 * Run: node --test scripts/check-silent-revert.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXEMPT_LABEL,
  applyDeclarations,
  findSilentReverts,
  formatFailure,
  parseDeclarations,
  parseRawDiffZ,
  prNumberOf,
} from './lib/silent-revert.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const CLI = join(HERE, 'check-silent-revert.mjs');

// ---------- rules on literals -------------------------------------------------

const ZERO = '0'.repeat(40);
const ch = (entries) => new Map(Object.entries(entries).map(([p, [o, n]]) => [p, { old: o, new: n }]));
const commit = (sha, subject, entries) => ({ sha, subject, changes: ch(entries) });

test('parseRawDiffZ reads -z raw records and rejects garbage', () => {
  const text = `:100644 100644 aaa bbb M\0a/b.rs\0:000000 100644 ${ZERO} ccc A\0new file.txt\0`;
  assert.deepEqual([...parseRawDiffZ(text)], [
    ['a/b.rs', { old: 'aaa', new: 'bbb' }],
    ['new file.txt', { old: ZERO, new: 'ccc' }],
  ]);
  assert.throws(() => parseRawDiffZ('garbage\0path\0'), /unparseable/);
});

test('prNumberOf reads the squash suffix only', () => {
  assert.equal(prNumberOf('fix(x): thing (Refs #7955) (#8360)'), 8360);
  assert.equal(prNumberOf('fix(x): mentions #12 in the middle'), null);
});

test('three restored files flag; two do not; a restore to the SAME bytes is not a change', () => {
  const c = commit('c1', 'feat: a (#1)', { a: ['a0', 'a1'], b: ['b0', 'b1'], c: ['c0', 'c1'] });
  const undo = (names) => ch(Object.fromEntries(names.map((n) => [n, [`${n}1`, `${n}0`]])));
  assert.equal(findSilentReverts({ net: undo(['a', 'b', 'c']), commits: [c], attributable: 1 }).length, 1);
  assert.equal(findSilentReverts({ net: undo(['a', 'b']), commits: [c], attributable: 1 }).length, 0);
  assert.equal(findSilentReverts({ net: undo(['a', 'b']), commits: [c], attributable: 1, minFiles: 2 }).length, 1);
  // The PR leaves b at C's bytes: not a restore, so only two of three count.
  const net = ch({ a: ['a1', 'a0'], c: ['c1', 'c0'], b: ['b1', 'b1'] });
  assert.equal(findSilentReverts({ net, commits: [c], attributable: 1 }).length, 0);
});

test('a deleted-added file is lifecycle, not evidence; a re-added deleted file is', () => {
  const added = commit('c1', 'feat: scaffolding (#1)', { a: [ZERO, 'a1'], b: [ZERO, 'b1'], c: [ZERO, 'c1'], d: [ZERO, 'd1'] });
  const remove = ch({ a: ['a1', ZERO], b: ['b1', ZERO], c: ['c1', ZERO], d: ['d1', ZERO] });
  assert.equal(findSilentReverts({ net: remove, commits: [added], attributable: 1 }).length, 0);
  const deleted = commit('c2', 'refactor: drop (#2)', { a: ['a1', ZERO], b: ['b1', ZERO], c: ['c1', ZERO] });
  const restore = ch({ a: [ZERO, 'a1'], b: [ZERO, 'b1'], c: [ZERO, 'c1'] });
  const [f] = findSilentReverts({ net: restore, commits: [deleted], attributable: 1 });
  assert.deepEqual(f.restored.map((r) => r.kind), ['re-added', 're-added', 're-added']);
});

test('#8377 repair: undoing a commit that itself reverted is not a revert', () => {
  // C1 changes three files; X puts them back to v0 (the silent revert); R re-lands v1.
  const c1 = commit('c1', 'fix: m10 (#8360)', { a: ['a0', 'a1'], b: ['b0', 'b1'], c: ['c0', 'c1'] });
  const x = commit('x', 'feat: viewer (#8377)', { a: ['a1', 'a0'], b: ['b1', 'b0'], c: ['c1', 'c0'] });
  const repair = ch({ a: ['a0', 'a1'], b: ['b0', 'b1'], c: ['c0', 'c1'] });
  assert.equal(findSilentReverts({ net: repair, commits: [x, c1], attributable: 2 }).filter((f) => f.sha === 'x').length, 0);
  // Without the older commit in view, X looks like ordinary work and the guard would cry wolf.
  assert.equal(findSilentReverts({ net: repair, commits: [x], attributable: 1 }).length, 1);
});

test('re-adding files a commit deleted is flagged even when the commit that CREATED them is in view', () => {
  // A creates three files, B deletes them (a legitimate cleanup), a PR silently brings them back.
  // A's pre-image and B's result are both all-zero: that is "no file", not a state to return to.
  const a = commit('a', 'feat: legacy module (#1)', { x: [ZERO, 'x1'], y: [ZERO, 'y1'], z: [ZERO, 'z1'] });
  const b = commit('b', 'refactor: remove legacy module (#2)', { x: ['x1', ZERO], y: ['y1', ZERO], z: ['z1', ZERO] });
  const net = ch({ x: [ZERO, 'x1'], y: [ZERO, 'y1'], z: [ZERO, 'z1'] });
  const found = findSilentReverts({ net, commits: [b, a], attributable: 2 });
  assert.deepEqual(found.map((f) => f.sha), ['b']);
  assert.deepEqual(found[0].restored.map((r) => r.kind), ['re-added', 're-added', 're-added']);
  assert.equal(found[0].unreverted.length, 0);
});

test('remedies follow the finding: git rm for re-added paths, a Reverts line only when a PR number exists', () => {
  const f = (pr, restored, lifecycle = []) => ({ sha: 'a'.repeat(40), subject: 's', pr, distance: 1, touched: 4, restored, lifecycle });
  const mixed = formatFailure([f(7, [{ path: 'a b.rs', kind: 're-added' }, { path: 'c.rs', kind: 'restored' }], ['d.rs'])]);
  assert.match(mixed, /git rm -- 'a b\.rs'/);
  assert.match(mixed, /git checkout origin\/main -- 'c\.rs' 'd\.rs'/);
  assert.match(mixed, /`Reverts #7`/);
  const onlyAdded = formatFailure([f(null, [{ path: 'a.rs', kind: 're-added' }])], 'upstream/main');
  assert.ok(!/git checkout/.test(onlyAdded), 'nothing to check out: every path is absent on the base');
  assert.ok(!/put a line/.test(onlyAdded), 'a commit with no PR number cannot be named');
  assert.match(onlyAdded, /none carries a PR number/);
  const onlyRestored = formatFailure([f(7, [{ path: 'c.rs', kind: 'restored' }])], 'upstream/main');
  assert.match(onlyRestored, /git checkout upstream\/main -- 'c\.rs'/);
  assert.ok(!/git rm/.test(onlyRestored));
});

test('declarations: revert titles, Reverts #N lines, the label; a stray word declares nothing', () => {
  for (const title of ['revert(geometry): back out the snap (#5733)', 'Revert "Fix Section Plane tool (#98)" (#100)', 'revert: x', 'revert!: x']) {
    assert.equal(parseDeclarations({ title }).all, true, title);
  }
  for (const title of ['feat(viewer): handle the revert button', 'fix: reverted state is shown', 'feat(revert-ui): new', 'Revert button is broken', 'revert the viewer change', 'Reverting is slow']) {
    assert.equal(parseDeclarations({ title }).all, false, title);
  }
  assert.deepEqual([...parseDeclarations({ body: 'Why\n\nReverts #8360, #8361 and #8362\n' }).prs], [8360, 8361, 8362]);
  assert.deepEqual([...parseDeclarations({ title: 'undoes: #7' }).prs], [7]);
  assert.equal(parseDeclarations({ body: 'this does not revert #8360 at all' }).prs.size, 0);
  assert.equal(parseDeclarations({ labels: [EXEMPT_LABEL] }).all, true);
  const scoped = applyDeclarations([{ pr: 1 }, { pr: 2 }], parseDeclarations({ body: 'Reverts #2' }));
  assert.deepEqual([scoped.undeclared, scoped.declared], [[{ pr: 1 }], [{ pr: 2 }]]);
});

// ---------- the CLI against real repositories ---------------------------------

const cleanup = [];
process.on('exit', () => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
};
delete ENV.PR_TITLE; delete ENV.PR_BODY; delete ENV.PR_LABELS; delete ENV.GITHUB_ACTIONS;

function git(repo, ...args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Write `files` (null deletes) and commit; returns the sha. */
function save(repo, files, subject) {
  for (const [p, content] of Object.entries(files)) {
    const full = join(repo, p);
    if (content === null) { rmSync(full, { force: true }); continue; }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', subject);
  return git(repo, 'rev-parse', 'HEAD');
}

const v = (name, n) => `${name} version ${n}\n`;
const SCOPED = ['rust/a.rs', 'rust/b.rs', 'docs/c.md', 'tests/d.txt'];

function newRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'silent-revert-'));
  cleanup.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  return repo;
}

function run(repo, args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, '--root', repo, ...args], { encoding: 'utf8', env: { ...ENV, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** A `gh` that answers every call with `answer` (or fails), put first on PATH. */
function fakeGh(answer) {
  const dir = mkdtempSync(join(tmpdir(), 'silent-revert-gh-'));
  cleanup.push(dir);
  const body = answer === null ? 'echo "HTTP 502" >&2\nexit 1\n' : `cat <<'JSON'\n${JSON.stringify(answer)}\nJSON\n`;
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\n${body}`);
  chmodSync(join(dir, 'gh'), 0o755);
  return { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r' };
}

/**
 * The incident's shape. #101 (C) rewrites four files and adds one; three
 * unrelated commits follow; the branch is cut AFTER them (so C is below the
 * merge base, as #8360 was below #8377's) and its commit puts the five files
 * back to their pre-#101 bytes alongside its own viewer change; main then
 * moves on twice more, leaving the branch stale.
 */
function incident({ branchTitle = 'feat(viewer): jump to top (#105)' } = {}) {
  const repo = newRepo();
  save(repo, { ...Object.fromEntries(SCOPED.map((p) => [p, v(p, 0)])), 'viewer.tsx': v('viewer', 0) }, 'init');
  save(repo, { ...Object.fromEntries(SCOPED.map((p) => [p, v(p, 1)])), 'rust/new.rs': v('new', 1) }, 'fix(retained): follow-ups (#101)');
  for (let i = 2; i <= 4; i += 1) save(repo, { [`filler/${i}.txt`]: v('f', i) }, `chore: filler (#10${i})`);
  git(repo, 'switch', '-q', '-c', 'feat');
  save(repo, { ...Object.fromEntries(SCOPED.map((p) => [p, v(p, 0)])), 'rust/new.rs': null, 'viewer.tsx': v('viewer', 1) }, branchTitle);
  git(repo, 'switch', '-q', 'main');
  for (let i = 6; i <= 7; i += 1) save(repo, { [`filler/${i}.txt`]: v('f', i) }, `chore: filler (#10${i})`);
  return repo;
}

test('the incident shape is flagged, names #101 and every restored file, and exits 1', () => {
  const repo = incident();
  const r = run(repo, ['--base', 'main', '--head', 'feat', '--title', 'feat(viewer): jump to top (#105)']);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /SILENT REVERT/);
  assert.match(r.err, /#101/);
  for (const p of SCOPED) assert.ok(r.err.includes(p), `${p} named`);
  assert.match(r.err, /deleted\s+rust\/new\.rs/);
  assert.match(r.err, /4 back to their exact pre-#101 bytes/);
});

test('C below the merge base is only reachable through the recent-N window', () => {
  const repo = incident();
  const args = ['--base', 'main', '--head', 'feat', '--title', 'feat: x'];
  const mb = git(repo, 'merge-base', 'main', 'feat');
  const c = git(repo, 'log', '--format=%H', '--grep=follow-ups', 'main');
  assert.notEqual(mb, c, 'the revert commit is below the merge base');
  assert.equal(run(repo, [...args, '--window', '20']).code, 1);
  // A window of 2 reaches only the two post-cut commits: the merge-base rule alone cannot see #101.
  const narrow = run(repo, [...args, '--window', '2']);
  assert.equal(narrow.code, 0, narrow.err);
});

test('declared reverts pass and say why; a wrong or absent declaration does not', () => {
  const repo = incident();
  const base = ['--base', 'main', '--head', 'feat'];
  const title = (t, extra = []) => run(repo, [...base, '--title', t, ...extra]);
  assert.equal(title('revert(retained): back out #101 follow-ups').code, 0);
  assert.equal(title('Revert "fix(retained): follow-ups (#101)"').code, 0);
  assert.match(title('revert: x').out, /Declared by a revert title/);
  assert.equal(title('feat: x', ['--body', 'Reverts #101']).code, 0);
  assert.match(title('feat: x', ['--body', 'Reverts #101']).out, /#101/);
  assert.equal(title('feat: x', ['--body', 'Reverts #999']).code, 1, 'naming a different PR declares nothing about #101');
  assert.equal(title('feat: handle the revert button').code, 1);
  const labelled = title('feat: x', ['--label', EXEMPT_LABEL]);
  assert.equal(labelled.code, 0);
  assert.match(labelled.out, new RegExp(`label ${EXEMPT_LABEL}`));
  // CI hands the declaration over through the environment.
  const viaEnv = run(repo, base, { PR_TITLE: 'feat: x', PR_LABELS: JSON.stringify([EXEMPT_LABEL]) });
  assert.equal(viaEnv.code, 0, viaEnv.err);
  assert.equal(run(repo, base, { PR_TITLE: 'feat: x', PR_LABELS: 'not json' }).code, 2);
});

test('a branch that silently re-adds files a recent cleanup deleted is flagged (both commits in the window)', () => {
  const repo = newRepo();
  const legacy = ['legacy/a.rs', 'legacy/b.rs', 'legacy/c.rs'];
  save(repo, { 'keep.txt': v('k', 0) }, 'init');
  save(repo, Object.fromEntries(legacy.map((p) => [p, v(p, 1)])), 'feat: legacy module (#101)');
  save(repo, Object.fromEntries(legacy.map((p) => [p, null])), 'refactor: remove legacy module (#102)');
  git(repo, 'switch', '-q', '-c', 'stale-tree');
  save(repo, { ...Object.fromEntries(legacy.map((p) => [p, v(p, 1)])), 'keep.txt': v('k', 1) }, 'feat: unrelated (#103)');
  git(repo, 'switch', '-q', 'main');
  const r = run(repo, ['--base', 'main', '--head', 'stale-tree', '--title', 'feat: unrelated (#103)']);
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /#102/);
  assert.match(r.err, /re-added\s+legacy\/a\.rs/);
  assert.match(r.err, /git rm -- 'legacy\/a\.rs'/);
  assert.ok(!/git checkout origin\/main -- 'legacy/.test(r.err), 'the files are absent on main; a checkout would fail');
});

test('--pr reads the declaration LIVE: the API wins over a stale env payload, and a failed read exits 2', () => {
  const repo = incident();
  const base = ['--base', 'main', '--head', 'feat', '--pr', '105'];
  // The event payload says "feat" (what a re-run would carry); the PR has since been retitled.
  const live = run(repo, base, { PR_TITLE: 'feat: x', ...fakeGh({ title: 'revert(retained): back out #101', body: null, labels: [] }) });
  assert.equal(live.code, 0, live.err);
  assert.match(live.out, /read live from the API/);
  // The reverse: the env says revert, the PR now says feat: judged on the live title, so flagged.
  const retitled = run(repo, base, { PR_TITLE: 'revert(x): y', ...fakeGh({ title: 'feat(viewer): jump (#105)', body: '', labels: [] }) });
  assert.equal(retitled.code, 1, retitled.err);
  assert.equal(run(repo, base, fakeGh({ title: 'feat: x', body: 'Reverts #101', labels: [] })).code, 0);
  assert.equal(run(repo, base, fakeGh({ title: 'feat: x', body: '', labels: [{ name: EXEMPT_LABEL }] })).code, 0);
  const broken = run(repo, base, fakeGh(null));
  assert.equal(broken.code, 2, `${broken.out}${broken.err}`);
  assert.match(broken.err, /could not read PR #105/);
  assert.equal(run(repo, base, fakeGh({ nonsense: true })).code, 2);
});

test('a declared revert writes itself to the step summary so a reviewer sees it', () => {
  const repo = incident();
  const summary = join(mkdtempSync(join(tmpdir(), 'silent-revert-sum-')), 'summary.md');
  cleanup.push(dirname(summary));
  const r = run(repo, ['--base', 'main', '--head', 'feat', '--title', 'revert(retained): back out #101'], { GITHUB_STEP_SUMMARY: summary });
  assert.equal(r.code, 0, r.err);
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /declared revert/);
  assert.match(text, /#101/);
  assert.match(text, /a revert title/);
});

test('a local run with no title reads the head commit message', () => {
  const repo = incident({ branchTitle: 'revert(retained): back out the follow-ups (#101)' });
  const r = run(repo, ['--base', 'main', '--head', 'feat']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /head commit message/);
});

test('a STALE branch that never touched those files is not a revert (two-dot diff would say it is)', () => {
  const repo = newRepo();
  save(repo, Object.fromEntries([...SCOPED, 'other.txt'].map((p) => [p, v(p, 0)])), 'init');
  git(repo, 'switch', '-q', '-c', 'stale');
  save(repo, { 'other.txt': v('other', 1) }, 'feat: unrelated (#50)');
  git(repo, 'switch', '-q', 'main');
  save(repo, Object.fromEntries(SCOPED.map((p) => [p, v(p, 1)])), 'fix: base moves on four files (#51)');
  save(repo, { 'filler.txt': v('f', 1) }, 'chore: filler (#52)');

  const r = run(repo, ['--base', 'main', '--head', 'stale', '--title', 'feat: unrelated (#50)']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /1 file\(s\) changed by the merge/);

  // The same facts through the naive head-vs-base diff DO flag, so the merged-tree evaluation is what earns the pass.
  const naive = parseRawDiffZ(git(repo, 'diff-tree', '-r', '-z', '--no-renames', 'main', 'stale'));
  const commits = git(repo, 'log', '--first-parent', '--format=%H%x1f%s', 'main').split('\n').slice(0, 2).map((line) => {
    const [sha, subject] = line.split('\x1f');
    return { sha, subject, changes: parseRawDiffZ(git(repo, 'diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', `${sha}^`, sha)) };
  });
  assert.equal(findSilentReverts({ net: naive, commits, attributable: 2 }).length, 1);
});

test('repairing a silent revert passes (the real 6b66b109c5 shape)', () => {
  const repo = newRepo();
  save(repo, Object.fromEntries(SCOPED.map((p) => [p, v(p, 0)])), 'init');
  save(repo, Object.fromEntries(SCOPED.map((p) => [p, v(p, 1)])), 'fix: work (#101)');
  save(repo, { ...Object.fromEntries(SCOPED.map((p) => [p, v(p, 0)])), 'viewer.tsx': v('viewer', 1) }, 'feat(viewer): x (#102)');
  git(repo, 'switch', '-q', '-c', 'repair');
  save(repo, Object.fromEntries(SCOPED.map((p) => [p, v(p, 1)])), 'fix: re-land the work (#103)');
  const r = run(repo, ['--base', 'main', '--head', 'repair', '--title', 'fix: re-land the work (#103)']);
  assert.equal(r.code, 0, r.err);
});

test('deleting files a commit created is ordinary lifecycle', () => {
  const repo = newRepo();
  save(repo, { 'keep.txt': v('k', 0) }, 'init');
  save(repo, Object.fromEntries(SCOPED.map((p) => [p, v(p, 1)])), 'feat: scaffolding (#101)');
  git(repo, 'switch', '-q', '-c', 'tidy');
  save(repo, Object.fromEntries(SCOPED.map((p) => [p, null])), 'refactor: supersede the scaffolding (#102)');
  git(repo, 'switch', '-q', 'main');
  const r = run(repo, ['--base', 'main', '--head', 'tidy', '--title', 'refactor: supersede (#102)']);
  assert.equal(r.code, 0, r.err);
});

// ---------- fail closed -------------------------------------------------------

test('a shallow checkout that cannot cover the window exits 2, never 0', () => {
  const repo = incident();
  const clone = mkdtempSync(join(tmpdir(), 'silent-revert-shallow-'));
  cleanup.push(clone);
  git(tmpdir(), 'clone', '-q', '--no-local', '--depth', '3', '--no-single-branch', `file://${repo}`, clone);
  const r = run(clone, ['--base', 'origin/main', '--head', 'origin/feat', '--title', 'feat: x']);
  assert.equal(r.code, 2, `${r.out}${r.err}`);
  assert.match(r.err, /COULD NOT EVALUATE/);
  assert.match(r.err, /shallow/);
});

test('a missing merge base, an unmergeable head, an unknown ref and a bad flag all exit 2', () => {
  const repo = newRepo();
  save(repo, { 'a.txt': v('a', 0) }, 'init');
  git(repo, 'switch', '-q', '-c', 'conflict');
  save(repo, { 'a.txt': v('a', 'branch') }, 'feat: edit (#1)');
  git(repo, 'switch', '-q', 'main');
  save(repo, { 'a.txt': v('a', 'main') }, 'fix: edit (#2)');
  const conflict = run(repo, ['--base', 'main', '--head', 'conflict', '--title', 'x']);
  assert.equal(conflict.code, 2);
  assert.match(conflict.err, /does not merge cleanly/);

  git(repo, 'switch', '-q', '--orphan', 'unrelated');
  save(repo, { 'z.txt': 'z\n' }, 'unrelated root');
  const noBase = run(repo, ['--base', 'main', '--head', 'unrelated', '--title', 'x']);
  assert.equal(noBase.code, 2);
  assert.match(noBase.err, /no merge base/);

  assert.equal(run(repo, ['--base', 'nope', '--head', 'main', '--title', 'x']).code, 2);
  assert.equal(run(repo, ['--window', '0']).code, 2);
  assert.equal(run(repo, ['--frobnicate']).code, 2);
});

test('a head already merged into the base is a clean no-op', () => {
  const repo = incident();
  const r = run(repo, ['--base', 'main', '--head', 'main', '--title', 'x']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /0 file\(s\) changed/);
});

// ---------- the real history --------------------------------------------------

const REQUIRE_HISTORY = process.env.SILENT_REVERT_REQUIRE_HISTORY === '1';
const isShallow = () => spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: REPO, encoding: 'utf8' }).stdout.trim() === 'true';
const missing = (shas) => shas.filter((s) => spawnSync('git', ['cat-file', '-e', `${s}^{commit}`], { cwd: REPO }).status !== 0);

/**
 * A reason to SKIP a real-history test, or false to run it. The #8377 PR head
 * (4b23992d54) is on no branch, so where the clone is complete but lacks it, it
 * is fetched from refs/pull/8377/head (CI, or SILENT_REVERT_REQUIRE_HISTORY=1).
 * In the silent-revert lane SILENT_REVERT_REQUIRE_HISTORY=1 turns every skip
 * into a failure, so the lane really replays the incident; elsewhere (the
 * shallow node-tests checkout) the skip names its true cause.
 */
function historyGap(shas) {
  const need = () => (isShallow() ? 'this is a shallow checkout' : `commit(s) ${missing(shas).map((m) => m.slice(0, 10)).join(', ')} are not in this clone`);
  if (!isShallow() && missing(shas).length && (REQUIRE_HISTORY || process.env.GITHUB_ACTIONS === 'true')) {
    spawnSync('git', ['fetch', '--no-tags', 'origin', 'refs/pull/8377/head'], { cwd: REPO, encoding: 'utf8' });
  }
  if (!isShallow() && !missing(shas).length) return false;
  const why = `${need()}; the silent-revert lane replays this with fetch-depth: 0 and the PR head ref`;
  assert.ok(!REQUIRE_HISTORY, `SILENT_REVERT_REQUIRE_HISTORY=1 demands the real replay, but ${why}`);
  return why;
}

test('#8377 (705eb56357) is flagged for #8360 (eaddb03505), replayed as the real stale PR', { skip: historyGap(['705eb56357', 'eaddb03505', '4b23992d54', '4f8c21e790']) }, () => {
  // PR head 4b23992d54 was cut on 70c91e8e61; main had moved to 4f8c21e790 by merge time.
  const r = spawnSync(process.execPath, [CLI, '--base', '4f8c21e790', '--head', '4b23992d54', '--title', 'feat(viewer): per-block jump to top/bottom in the Document panel (#8227)', '--body', 'Closes #8227'], { cwd: REPO, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /#8360/);
  assert.match(r.stderr, /rust\/retained-native\/src\/oracle\/affine\.rs/);
  assert.match(r.stderr, /deleted\s+rust\/retained-native\/src\/oracle\/affine_classify\.rs/);
});

test('the last 100 commits of main before this guard flag only #8377', { skip: historyGap(['87d8fdf359', '705eb56357']) }, () => {
  const r = spawnSync(process.execPath, [CLI, '--scan', '100', '--base', '87d8fdf359', '--json'], { cwd: REPO, encoding: 'utf8', env: ENV });
  const result = JSON.parse(r.stdout);
  assert.equal(result.scanned, 100);
  assert.deepEqual(result.flagged.map((f) => f.sha.slice(0, 10)), ['705eb56357']);
});

test('the PR that repaired #8377 (6b66b109c5) passes as a PR', { skip: historyGap(['6b66b109c5', '705eb56357']) }, () => {
  const r = spawnSync(process.execPath, [CLI, '--base', '6b66b109c5^', '--head', '6b66b109c5', '--title', 'fix(retained): M10 classification nits'], { cwd: REPO, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
});
