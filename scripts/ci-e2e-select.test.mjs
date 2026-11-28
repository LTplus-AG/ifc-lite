/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

// PR #11515 exercises the CLI through the same entry point CI uses.
const CLI = fileURLToPath(new URL('./ci-e2e-select.mjs', import.meta.url));
const smoke = 'tests/e2e/viewer-smoke.e2e.spec.ts';
const changed = 'tests/e2e/changed.e2e.spec.ts';
const unchanged = 'tests/e2e/unchanged.e2e.spec.ts';
const removed = 'tests/e2e/removed.e2e.spec.ts';

function fixture(t, { edits, deletions = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-selected-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const clone = join(dir, 'clone');
  mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (message) => {
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', message);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const write = (path, contents = '') => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
  };

  git(repo, 'init', '-qb', 'main');
  write('playwright.config.ts', "testDir: './tests',\n{ name: 'viewer-e2e-ci', testMatch: /\\.e2e\\.spec\\.ts$/, }");
  for (const path of [unchanged, smoke, ...deletions]) write(path);
  commit('initial');
  git(repo, 'checkout', '-qb', 'pr');
  for (const path of edits) write(path, 'PR change');
  for (const path of deletions) rmSync(join(repo, path));
  const headSha = commit('PR changes');
  git(repo, 'checkout', '-q', 'main');
  write(unchanged, 'base-only change');
  const baseSha = commit('base moved');
  git(repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'merge', '-q', '--no-ff', 'pr', '-m', 'test merge');
  const mergeSha = git(repo, 'rev-parse', 'HEAD');
  git(dir, 'clone', '-q', '--depth=2', pathToFileURL(repo).href, clone);

  const evidence = join(dir, 'evidence');
  const output = join(dir, 'outputs');
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args, evidence], {
    cwd: clone, encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_SHA: mergeSha, PR_HEAD_SHA: headSha, GITHUB_OUTPUT: output,
      PR_NUMBER: '42', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
      ...env,
    },
  });
  return {
    run, evidence, output, baseSha, headSha, mergeSha,
    plan: () => JSON.parse(readFileSync(join(evidence, 'plan.json'), 'utf8')),
  };
}

test('selects the changed CI spec from the depth-two tested merge, excluding base drift', (t) => {
  const f = fixture(t, { edits: [changed] });
  const result = f.run(['--plan']);
  assert.equal(result.status, 0);
  assert.deepEqual(f.plan(), {
    schemaVersion: 1, pr: '42', runId: '123', runAttempt: '2',
    baseSha: f.baseSha, headSha: f.headSha, mergeSha: f.mergeSha,
    coverage: 'changed-specs-only', unknownPaths: [],
    selected: [{ file: changed, reason: 'changed-spec' }], omittedSpecs: [unchanged, smoke],
  });

  const listing = join(f.evidence, 'list.txt');
  writeFileSync(listing, '  [viewer-e2e-ci] › e2e/unchanged.e2e.spec.ts:1:1 › wrong spec\n');
  assert.equal(f.run(['--check-list']).status, 1, 'rejects a different Playwright inventory');
  writeFileSync(listing, '  [viewer-e2e-ci] › e2e/changed.e2e.spec.ts:1:1 › selected spec\n');
  const check = f.run(['--check-list']);
  assert.equal(check.status, 0);
});

test('samples smoke for shared inputs and reports unproven paths and omissions', (t) => {
  const source = 'rust/geometry/src/lib.rs';
  const f = fixture(t, { edits: [changed, source], deletions: [removed] });
  const result = f.run(['--plan']);
  assert.equal(result.status, 0);
  const { coverage, unknownPaths, selected, omittedSpecs } = f.plan();
  assert.deepEqual({ coverage, unknownPaths, selected, omittedSpecs }, {
    coverage: 'unknown', unknownPaths: [source, removed],
    selected: [{ file: changed, reason: 'changed-spec' }, { file: smoke, reason: 'shared-input-smoke' }],
    omittedSpecs: [unchanged],
  });
});

test('unmapped changes and a mismatched checkout never opt into a browser run', (t) => {
  const f = fixture(t, { edits: ['docs/example.md'] });
  const result = f.run(['--plan']);
  assert.equal(result.status, 0);
  assert.deepEqual(f.plan().selected, []);
  assert.equal(f.plan().coverage, 'unknown');
  assert.equal(readFileSync(f.output, 'utf8'), 'run=false\ncoverage=unknown\ncount=0\n');

  const bad = f.run(['--plan'], { PR_HEAD_SHA: f.baseSha });
  assert.equal(bad.status, 1);
  const rejected = f.plan();
  assert.equal(rejected.coverage, 'unknown');
  assert.deepEqual(rejected.selected, []);
});
