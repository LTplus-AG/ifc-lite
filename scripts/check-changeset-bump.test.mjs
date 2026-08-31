#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-changeset-bump.mjs.
 *
 * A gate is only worth its CI minute if it can go RED, so the load-bearing
 * tests here are MATCHED PAIRS: two runs that differ in exactly one field and
 * disagree on the exit code. If a pair ever agrees, the field it varies has
 * stopped being what decides, and the gate has quietly become a no-op — which
 * is the shape #3175 was: a 42-PR batch where every check was green and nothing
 * had read a single changeset.
 *
 *   shrink + patch   -> 1     vs   shrink + major   -> 0    (the bump decides)
 *   shrink + patch   -> 1     vs   additive + patch -> 0    (the shrink decides)
 *   1.x + minor      -> 1     vs   0.x + minor      -> 0    (the version decides)
 *
 * The fixtures are not invented shapes. `RENDERER_BEFORE`/`RENDERER_AFTER` are
 * the `@ifc-lite/renderer` entries as they actually stand either side of
 * bcd716a0b (`refactor(renderer)!: narrow getScene …`, #3360): `PickingManager`,
 * `Scene` and `Section2DOverlayRenderer` removed, `SceneContents` added. That
 * PR took `major` and was right to; the RED case is the same diff with the
 * frontmatter #3175 kept finding.
 *
 * The other half is anti-vacuity. Every way this guard could scan nothing and
 * pass — no changesets at all, an unreadable snapshot on either side, no
 * release anchor, a shrunk package with no version — is asserted to exit
 * non-zero with a named reason. The "no pending changesets" case gets two
 * tests, not one: a clean pass when nothing shrank, and a REFUSAL when
 * something did. That pair exists because "no changesets, so nothing to check"
 * is the single most natural early return to write here, and it would make the
 * absence of a changeset read as proof of correctness.
 *
 * Method matches scripts/check-loader-hook-specifier-match.test.mjs: build a
 * tree in a temp dir outside the repo and run the UNMODIFIED checker against it
 * via --root / --baseline-file / --current-file.
 *
 * The last test runs the checker with NO flags against the real repository, so
 * the configuration that ships is exercised too — and asserts it reports the
 * renderer shrink it should be finding, because a green run that examined
 * nothing looks identical to a green run that examined everything.
 *
 * Run: node --test scripts/check-changeset-bump.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');
const CHECKER = join(SCRIPTS, 'check-changeset-bump.mjs');

/** `@ifc-lite/renderer` before bcd716a0b, trimmed to the members that move. */
const RENDERER_BEFORE = [
  'Picker: class',
  'PickingManager: class',
  'Renderer: class',
  'Scene: class',
  'Section2DOverlayRenderer: class',
];

/** …and after it: three classes unexported, one interface published. */
const RENDERER_AFTER = [
  'Picker: class',
  'Renderer: class',
  'SceneContents: interface',
];

/**
 * Build a tree the checker can read: packages/<dir>/package.json per entry in
 * `versions`, one changeset per entry in `changesets`, and the two snapshots as
 * loose JSON files.
 *
 * @param {{ baseline: object, current: object,
 *           versions?: Record<string, string>,
 *           changesets?: Record<string, Record<string, string>> }} spec
 */
function makeTree(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'changeset-bump-'));
  mkdirSync(join(dir, 'packages'), { recursive: true });
  for (const [name, version] of Object.entries(spec.versions ?? {})) {
    // packages/<dirname>/package.json — the directory name is irrelevant to the
    // checker, which keys on the manifest's `name`, so derive it mechanically.
    const pkgDir = join(dir, 'packages', name.replace(/^@[^/]+\//, ''));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
  }
  mkdirSync(join(dir, '.changeset'), { recursive: true });
  for (const [file, releases] of Object.entries(spec.changesets ?? {})) {
    const frontmatter = Object.entries(releases)
      .map(([name, type]) => `'${name}': ${type}`)
      .join('\n');
    writeFileSync(
      join(dir, '.changeset', `${file}.md`),
      `---\n${frontmatter}\n---\n\nfixture body\n`,
    );
  }
  writeFileSync(join(dir, 'baseline.json'), JSON.stringify(spec.baseline, null, 2));
  writeFileSync(join(dir, 'current.json'), JSON.stringify(spec.current, null, 2));
  return dir;
}

/** Run the unmodified checker against a fixture tree. */
function runOn(dir, extraArgs = []) {
  const res = spawnSync(
    process.execPath,
    [
      CHECKER,
      '--root',
      dir,
      '--baseline-file',
      join(dir, 'baseline.json'),
      '--current-file',
      join(dir, 'current.json'),
      ...extraArgs,
    ],
    { encoding: 'utf8' },
  );
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

/** makeTree + runOn + cleanup, since every test does exactly that. */
function check(spec, extraArgs = []) {
  const dir = makeTree(spec);
  try {
    return runOn(dir, extraArgs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SHRANK = {
  baseline: { '@ifc-lite/renderer': RENDERER_BEFORE },
  current: { '@ifc-lite/renderer': RENDERER_AFTER },
  versions: { '@ifc-lite/renderer': '1.50.0' },
};

// --- the pair the whole gate exists for -------------------------------------

test('RED: surface shrank and the changeset says patch', () => {
  const { status, out } = check({
    ...SHRANK,
    changesets: { 'renderer-2-0': { '@ifc-lite/renderer': 'patch' } },
  });
  assert.equal(status, 1, out);
  assert.match(out, /@ifc-lite\/renderer@1\.50\.0/);
  assert.match(out, /declared: patch/);
  assert.match(out, /required: major/);
  // The three exports that actually went away must be named, not just counted:
  // "something shrank" sends the reader back to a 4,000-line diff.
  assert.match(out, /removed\s+PickingManager: class/);
  assert.match(out, /removed\s+Scene: class/);
  assert.match(out, /removed\s+Section2DOverlayRenderer: class/);
  assert.match(out, /\.changeset\/renderer-2-0\.md\s+->\s+patch/);
  // The remedy must say RAISE THE BUMP. A remedy that read "restore the export"
  // would contradict the finding: the snapshot was updated deliberately.
  assert.match(out, /raise the level in the changeset file/i);
  assert.match(out, /#3175/);
});

test('GREEN: the same shrink with the bump AGENTS.md:68 requires', () => {
  const { status, out } = check({
    ...SHRANK,
    changesets: { 'renderer-2-0': { '@ifc-lite/renderer': 'major' } },
  });
  assert.equal(status, 0, out);
  // Not a silent pass: it says what it found and what cleared it, so a green
  // run that examined nothing cannot be mistaken for this one.
  assert.match(out, /1 package\(s\) shrank/);
  assert.match(out, /major >= major/);
});

test('GREEN: an ADDITIVE change with the same patch bump', () => {
  const { status, out } = check({
    baseline: { '@ifc-lite/renderer': RENDERER_AFTER },
    current: { '@ifc-lite/renderer': [...RENDERER_AFTER, 'NewThing: function'] },
    versions: { '@ifc-lite/renderer': '1.50.0' },
    changesets: { 'renderer-add': { '@ifc-lite/renderer': 'patch' } },
  });
  assert.equal(status, 0, out);
  assert.match(out, /no published export removed or demoted/);
});

// --- the version branch -----------------------------------------------------

test('RED: minor is not enough for a >=1.0 package', () => {
  const { status, out } = check({
    ...SHRANK,
    changesets: { 'renderer-2-0': { '@ifc-lite/renderer': 'minor' } },
  });
  assert.equal(status, 1, out);
  assert.match(out, /declared: minor\s+required: major/);
});

test('GREEN: minor IS enough for a 0.x package', () => {
  const { status, out } = check({
    baseline: { '@ifc-lite/collab': ['branchOverlay: function', 'joinRoom: function'] },
    current: { '@ifc-lite/collab': ['joinRoom: function'] },
    versions: { '@ifc-lite/collab': '0.6.0' },
    changesets: { 'collab-overlay': { '@ifc-lite/collab': 'minor' } },
  });
  assert.equal(status, 0, out);
  assert.match(out, /minor >= minor/);
});

test('RED: patch is not enough for a 0.x package either', () => {
  const { status, out } = check({
    baseline: { '@ifc-lite/collab': ['branchOverlay: function', 'joinRoom: function'] },
    current: { '@ifc-lite/collab': ['joinRoom: function'] },
    versions: { '@ifc-lite/collab': '0.6.0' },
    changesets: { 'collab-overlay': { '@ifc-lite/collab': 'patch' } },
  });
  assert.equal(status, 1, out);
  assert.match(out, /@ifc-lite\/collab@0\.6\.0/);
  assert.match(out, /declared: patch\s+required: minor/);
});

// --- the second failure class, with its own remedy --------------------------

test('RED: a shrink that NO pending changeset names', () => {
  const { status, out } = check({
    ...SHRANK,
    changesets: { unrelated: { '@ifc-lite/bcf': 'patch' } },
  });
  assert.equal(status, 1, out);
  assert.match(out, /no pending changeset naming the/);
  assert.match(out, /\(no changeset\)/);
  // A DIFFERENT remedy from the under-bumped class. Telling someone to raise a
  // level in a file that does not exist is the failure mode this pair pins.
  assert.match(out, /pnpm changeset/);
  assert.match(out, /NOT the same fix as raising an existing changeset/);
});

test('RED: a shrink with ZERO pending changesets — absence is not success', () => {
  const { status, out } = check({ ...SHRANK, changesets: {} });
  assert.equal(status, 1, out);
  assert.match(out, /no pending changeset naming the/);
});

test('GREEN: zero pending changesets and nothing shrank', () => {
  const { status, out } = check({
    baseline: { '@ifc-lite/renderer': RENDERER_AFTER },
    current: { '@ifc-lite/renderer': RENDERER_AFTER },
    changesets: {},
  });
  assert.equal(status, 0, out);
  assert.match(out, /0 pending changeset/);
});

// --- what counts as a shrink ------------------------------------------------

test('RED: an entire published surface key disappearing', () => {
  const { status, out } = check({
    baseline: {
      '@ifc-lite/clash': ['detect: function'],
      '@ifc-lite/clash/bcf': ['clashesToBCF: function'],
    },
    current: { '@ifc-lite/clash': ['detect: function'] },
    versions: { '@ifc-lite/clash': '2.0.0' },
    changesets: { 'clash-drop-subpath': { '@ifc-lite/clash': 'patch' } },
  });
  assert.equal(status, 1, out);
  // Attributed to the PACKAGE, because that is what a changeset can name.
  assert.match(out, /@ifc-lite\/clash@2\.0\.0/);
  assert.match(out, /removed\s+clashesToBCF: function\s+\(@ifc-lite\/clash\/bcf\)/);
});

test('RED: a subpath shrink is charged to the package that publishes it', () => {
  const { status, out } = check({
    baseline: { '@ifc-lite/clash/bcf': ['clashesToBCF: function', 'bcfCamera: function'] },
    current: { '@ifc-lite/clash/bcf': ['clashesToBCF: function'] },
    versions: { '@ifc-lite/clash': '2.0.0' },
    changesets: { 'clash-bcf': { '@ifc-lite/clash': 'patch' } },
  });
  assert.equal(status, 1, out);
  assert.match(out, /@ifc-lite\/clash@2\.0\.0/);
  assert.match(out, /removed\s+bcfCamera: function\s+\(@ifc-lite\/clash\/bcf\)/);
});

test('RED: a value export demoted to type-only', () => {
  const { status, out } = check({
    baseline: { '@ifc-lite/bcf': ['BCFViewpoint: class'] },
    current: { '@ifc-lite/bcf': ['BCFViewpoint: class (type-only)'] },
    versions: { '@ifc-lite/bcf': '2.0.1' },
    changesets: { 'bcf-demote': { '@ifc-lite/bcf': 'patch' } },
  });
  assert.equal(status, 1, out);
  assert.match(out, /demoted\s+BCFViewpoint: class -> class \(type-only\)/);
  assert.match(out, /erased at runtime/);
});

test('GREEN, but reported: a kind change that is not a type-only demotion', () => {
  const { status, out } = check({
    baseline: { '@ifc-lite/bcf': ['BCFOptions: interface'] },
    current: { '@ifc-lite/bcf': ['BCFOptions: type'] },
    versions: { '@ifc-lite/bcf': '2.0.1' },
    changesets: { 'bcf-kind': { '@ifc-lite/bcf': 'patch' } },
  });
  // Deliberately advisory — see the checker's header. Pinned so that turning it
  // into a gate is a visible decision rather than a drive-by.
  assert.equal(status, 0, out);
  assert.match(out, /BCFOptions: interface -> type/);
  assert.match(out, /not gated/);
});

// --- level arithmetic -------------------------------------------------------

test('GREEN: the HIGHEST level across several changesets is what counts', () => {
  const { status, out } = check({
    ...SHRANK,
    // The filenames are chosen so that the `major` one is NEITHER first nor
    // last in the sorted read order. An earlier version of this fixture named
    // the major changeset `renderer-2-0`, which sorts first — so a checker
    // taking the FIRST declaration instead of the highest passed it, and a
    // mutation run caught the fixture rather than the code.
    changesets: {
      'aa-renderer-typo': { '@ifc-lite/renderer': 'patch' },
      'mm-renderer-2-0': { '@ifc-lite/renderer': 'major' },
      'zz-renderer-perf': { '@ifc-lite/renderer': 'patch' },
    },
  });
  // Taking the first, the last, or the minimum would all red this. A package
  // routinely collects several pending changesets; only one has to declare the
  // break.
  assert.equal(status, 0, out);
  assert.match(out, /major >= major/);
});

test('RED: `none` does not clear a shrink', () => {
  const { status, out } = check({
    ...SHRANK,
    changesets: { 'renderer-2-0': { '@ifc-lite/renderer': 'none' } },
  });
  assert.equal(status, 1, out);
  assert.match(out, /declared: none\s+required: major/);
});

// --- refusals: every way to scan nothing and pass ---------------------------

test('REFUSE: the current snapshot is unreadable', () => {
  const dir = makeTree({ baseline: {}, current: {}, changesets: {} });
  try {
    const res = spawnSync(
      process.execPath,
      [CHECKER, '--root', dir, '--baseline-file', join(dir, 'baseline.json'),
        '--current-file', join(dir, 'no-such-file.json')],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /current API-surface snapshot is unreadable/);
    assert.match(res.stderr, /pnpm api-surface:update/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REFUSE: the baseline snapshot is unreadable', () => {
  const dir = makeTree({ baseline: {}, current: {}, changesets: {} });
  try {
    const res = spawnSync(
      process.execPath,
      [CHECKER, '--root', dir, '--baseline-file', join(dir, 'no-such-file.json'),
        '--current-file', join(dir, 'current.json')],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /baseline API-surface snapshot is unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REFUSE: malformed JSON is not an empty snapshot', () => {
  const dir = makeTree({ baseline: {}, current: {}, changesets: {} });
  try {
    writeFileSync(join(dir, 'baseline.json'), '{ not json');
    const res = runOn(dir);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /baseline API-surface snapshot is unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REFUSE: no release anchor in history', () => {
  // A temp dir is not a git repository, so deriving the anchor must fail — and
  // fail LOUDLY. Reading "no anchor" as "no drift" would green every run made
  // on a shallow clone, which is what CI checks out by default.
  const dir = makeTree({ baseline: {}, current: {}, changesets: {} });
  try {
    const res = spawnSync(
      process.execPath,
      [CHECKER, '--root', dir, '--current-file', join(dir, 'current.json')],
      { encoding: 'utf8' },
    );
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /no release anchor found in history/);
    assert.match(res.stderr, /--baseline-ref/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A real git repo in temp, so `git log` SUCCEEDS and the empty-match branch runs. */
function gitInit(dir, subject) {
  const git = (...args) =>
    spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '--no-gpg-sign', '-m', subject);
  return git;
}

/**
 * A temp git repo shaped like the real one: a commit carrying
 * `scripts/api-surface.json` at the PRE-shrink surface plus a changeset (so the
 * anchor's `.changeset` pathspec is satisfied the way a real release commit
 * satisfies it), then a working tree holding the POST-shrink surface and the
 * changeset under test.
 *
 * These tests take NO --baseline-file, so the whole git derivation runs for
 * real: subject match, pathspec, `git show <sha>:scripts/api-surface.json`.
 */
function makeGitTree({ subject, bump }) {
  const dir = mkdtempSync(join(tmpdir(), 'changeset-bump-git-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, '.changeset'), { recursive: true });
  mkdirSync(join(dir, 'packages', 'renderer'), { recursive: true });
  writeFileSync(
    join(dir, 'packages', 'renderer', 'package.json'),
    JSON.stringify({ name: '@ifc-lite/renderer', version: '1.50.0' }),
  );
  writeFileSync(
    join(dir, 'scripts', 'api-surface.json'),
    JSON.stringify({ '@ifc-lite/renderer': RENDERER_BEFORE }, null, 2),
  );
  // A release commit DELETES changesets, so it touches .changeset/. Give the
  // anchor commit one to delete, or the pathspec half of the conjunction can
  // never match and the subject half is never reached.
  writeFileSync(join(dir, '.changeset', 'drained.md'), '---\n---\n\ndrained at release\n');
  gitInit(dir, subject);
  // …and now the unreleased work: the surface shrinks, a changeset appears.
  writeFileSync(
    join(dir, 'scripts', 'api-surface.json'),
    JSON.stringify({ '@ifc-lite/renderer': RENDERER_AFTER }, null, 2),
  );
  writeFileSync(
    join(dir, '.changeset', 'renderer-2-0.md'),
    `---\n'@ifc-lite/renderer': ${bump}\n---\n\nnarrow getScene\n`,
  );
  return dir;
}

function runGit(dir) {
  const res = spawnSync(process.execPath, [CHECKER, '--root', dir], { encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

test('REFUSE: git works but no commit is a release anchor', () => {
  // The branch a NON-git temp dir never reaches: `git log --grep` exits 0 and
  // prints nothing. It survived a mutation that replaced the empty-match
  // refusal with `sha || 'HEAD'` until this test existed — exactly the shape
  // that would make every shallow CI run pass silently.
  const dir = makeGitTree({ subject: 'feat: not a release commit', bump: 'patch' });
  try {
    const { status, out } = runGit(dir);
    assert.equal(status, 1, out);
    assert.match(out, /no release anchor found in history/);
    // Not shallow, so the remedy must be the --baseline-ref one, NOT the
    // fetch-depth one. Printing the wrong remedy is its own defect.
    assert.match(out, /--baseline-ref/);
    assert.doesNotMatch(out, /fetch-depth/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RED end-to-end: baseline derived from a real release commit', () => {
  // The matched partner of the refusal above. The ONLY difference is the commit
  // subject; if these two ever agree, the anchor regex has stopped deciding.
  const dir = makeGitTree({ subject: 'chore: version packages (#3349)', bump: 'patch' });
  try {
    const { status, out } = runGit(dir);
    assert.equal(status, 1, out);
    assert.doesNotMatch(out, /refused to run/);
    assert.match(out, /declared: patch\s+required: major/);
    assert.match(out, /removed\s+Scene: class/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GREEN end-to-end: the same history with the required bump', () => {
  const dir = makeGitTree({ subject: 'chore: version packages (#3349)', bump: 'major' });
  try {
    const { status, out } = runGit(dir);
    assert.equal(status, 0, out);
    assert.match(out, /1 package\(s\) shrank/);
    assert.match(out, /major >= major/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REFUSE: a shrunk package with no package.json to read a version from', () => {
  const { status, out } = check({
    baseline: { '@ifc-lite/ghost': ['gone: function'] },
    current: { '@ifc-lite/ghost': [] },
    versions: {},
    changesets: { ghost: { '@ifc-lite/ghost': 'patch' } },
  });
  assert.equal(status, 1, out);
  assert.match(out, /no readable version/);
  assert.match(out, /@ifc-lite\/ghost/);
});

test('REFUSE: an unparseable version cannot pick a required level', () => {
  const { status, out } = check({
    baseline: { '@ifc-lite/renderer': RENDERER_BEFORE },
    current: { '@ifc-lite/renderer': RENDERER_AFTER },
    versions: { '@ifc-lite/renderer': 'workspace:*' },
    changesets: { 'renderer-2-0': { '@ifc-lite/renderer': 'patch' } },
  });
  assert.equal(status, 1, out);
  assert.match(out, /unparseable version/);
});

test('REFUSE: a changeset whose frontmatter cannot be parsed', () => {
  const dir = makeTree({ ...SHRANK, changesets: {} });
  try {
    writeFileSync(join(dir, '.changeset', 'broken.md'), 'no frontmatter at all\n');
    const res = runOn(dir);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /could not be read as changesets/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the shipped configuration ----------------------------------------------

test('the real repository passes, and the run is not vacuous', () => {
  const res = spawnSync(process.execPath, [CHECKER], { cwd: ROOT, encoding: 'utf8' });
  const out = `${res.stdout}${res.stderr}`;
  assert.equal(res.status, 0, out);
  // Anti-vacuity: the tree really does carry an unreleased shrink
  // (bcd716a0b unexported Scene, PickingManager and Section2DOverlayRenderer),
  // so a run reporting zero shrinks here would mean the baseline derivation had
  // silently stopped finding anything to compare against.
  assert.match(out, /pending changeset\(s\)/);
  // And the SHRINK RESULT itself, not merely that a changeset was found. Without
  // this the test still passes if baseline derivation silently stops comparing
  // API surfaces and reports zero shrunk packages: a green run over a check that
  // did nothing, which is the shape this gate exists to prevent.
  assert.match(out, /1 package\(s\) shrank/);
});
