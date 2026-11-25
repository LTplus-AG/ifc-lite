/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./ci-node-test-shards.mjs', import.meta.url));

test('Node shadow trusts the PR merge parent and declines shared inputs or a different head', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'node-shadow-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'commit.gpgsign', 'false');
  const source = join(cwd, 'packages', 'leaf', 'src');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'index.js'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('switch', '-qc', 'feature');
  writeFileSync(join(source, 'index.js'), 'export const value = 2;\n');
  git('commit', '-qam', 'edit');
  const head = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'PR merge', 'feature');

  const event = join(cwd, 'event.json');
  const output = join(cwd, 'output');
  const preflight = (sha, eventName = 'pull_request') => {
    writeFileSync(output, '');
    writeFileSync(event, JSON.stringify({ pull_request: { head: { sha, ref: 'feature' } } }));
    return spawnSync(process.execPath, [cli, '--shadow-preflight'], {
      cwd, encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output,
        GITHUB_EVENT_NAME: eventName, GITHUB_STEP_SUMMARY: '' },
    });
  };

  const eligible = preflight(head);
  assert.equal(eligible.status, 0, eligible.stderr);
  assert.equal(readFileSync(output, 'utf8'), 'eligible=true\n');
  assert.equal(preflight(head, 'merge_group').status, 1);
  assert.equal(preflight('a'.repeat(40)).status, 1);
  assert.equal(readFileSync(output, 'utf8'), '');

  git('reset', '--hard', 'HEAD^1');
  git('switch', '-q', 'feature');
  writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'shared input\n');
  git('add', 'pnpm-lock.yaml');
  git('commit', '-qm', 'shared input');
  const mixedHead = git('rev-parse', 'HEAD');
  git('switch', '-q', 'main');
  git('merge', '--no-ff', '-qm', 'PR merge with shared input', 'feature');
  const declined = preflight(mixedHead);
  assert.equal(declined.status, 0, declined.stderr);
  assert.equal(readFileSync(output, 'utf8'), 'eligible=false\n');
});
