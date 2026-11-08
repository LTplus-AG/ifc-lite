/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as walker from './walk.mjs';

const script = fileURLToPath(new URL('./walk.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../../packages/cli/dist/index.js', import.meta.url));
const fixture = readFileSync(new URL('../../tests/fixtures/cli-retained/layered-wall.ifc', import.meta.url), 'utf8');

function history(t) {
  const repo = mkdtempSync(join(tmpdir(), 'ifc-history-test-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  }).trim();
  git('init', '--quiet');
  const path = 'model with spaces.ifc';
  const commit = (bytes, name) => {
    writeFileSync(join(repo, path), bytes);
    git('add', '--', path);
    git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  const base = commit(fixture, 'base');
  const same = commit(fixture.replace('synthetic.ifc', 'delivery.ifc'), 'header only');
  const modified = commit(fixture.replace('stable-box', 'edited-box'), 'attribute edit');
  let id = 0;
  const regenerated = fixture.replace('stable-box', 'edited-box')
    .replace(/(=IFC[A-Z0-9_]+\()'[^']*'/g, (prefix) => {
      // Every IfcRoot's first argument is a GlobalId; non-root first strings
      // in this fixture are not matched (their first argument is not a string).
      return prefix.slice(0, prefix.indexOf("'")) + `'${String(++id).padStart(22, '0')}'`;
    });
  const renamed = commit(regenerated, 'all GlobalIds regenerated');
  return { repo, git, path, base, same, modified, renamed, commit, regenerated };
}

test('#9332 real CLI: consecutive revisions distinguish unchanged, modified and re-GUIDed', (t) => {
  assert.equal(typeof walker.walkHistory, 'function');
  const h = history(t);
  const lines = [];
  walker.walkHistory({ repository: h.repo, command: [process.execPath, cli], out: line => lines.push(line) });
  assert.equal(lines.length, 3);
  const counts = [
    '1 unchanged, 0 modified, 0 added, 0 deleted, 0 content-matches',
    '0 unchanged, 1 modified, 0 added, 0 deleted, 0 content-matches',
    '0 unchanged, 0 modified, 0 added, 0 deleted, 1 content-matches (1 renamed)',
  ];
  for (const [i, [base, head]] of [[h.base, h.same], [h.same, h.modified], [h.modified, h.renamed]].entries()) {
    assert.equal(lines[i], `${head.slice(0, 12)}: ${counts[i]}; ${base.slice(0, 12)} -> ${head.slice(0, 12)} ${JSON.stringify(h.path)}`);
  }
  // The walk must ignore dirty working files and support a pinned tip.
  writeFileSync(join(h.repo, h.path), 'not IFC');
  const pinned = [];
  walker.walkHistory({ repository: h.repo, ref: h.same, command: [process.execPath, cli], out: line => pinned.push(line) });
  assert.deepEqual(pinned, lines.slice(0, 1));
  assert.ok(h.git('status', '--porcelain').includes(h.path));
});

test('#9332 failed pair exits nonzero and identifies the commit and path', (t) => {
  const h = history(t);
  const result = spawnSync(process.execPath, [script, h.repo, '--ifc-lite', join(h.repo, 'missing-binary')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(h.same));
  assert.ok(result.stderr.includes(h.path));
});
