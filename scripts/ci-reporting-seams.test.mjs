/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = (name) => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');

function job(text, id) {
  const match = text.match(new RegExp(`^  ${id}:\\r?\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\r?$|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `workflow must contain job ${id}`);
  return match[0];
}

function step(text, name) {
  const start = text.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `workflow must contain step ${name}`);
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^\s*- (?:name:|uses:)/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('#4144: the review canary reports and fails even when its result output is absent', () => {
  const text = workflow('review-lane-canary.yml');
  for (const name of ['Raise or update the ops issue', 'Fail the run if the lane is down']) {
    assert.match(step(text, name), /if: always\(\) && steps\.canary\.outputs\.rc != '0'/);
  }
});

test('#4144: documentation cannot deploy without both generated entry points', () => {
  const text = workflow('docs.yml');
  assert.doesNotMatch(job(text, 'build'), /continue-on-error:\s*true/);
  const verify = step(text, 'Verify site structure');
  assert.match(verify, /test -f site\/index\.html/);
  assert.match(verify, /test -f site\/api\/rust\/index\.html/);
  assert.doesNotMatch(verify, /\|\|\s*echo/);
});

test('#4144: release verification is fail-closed on a missing producer output', () => {
  const text = workflow('release.yml');
  for (const id of ['verify-npm-publish', 'verify-crates-publish']) {
    assert.match(job(text, id), /if: always\(\) && needs\.release\.outputs\.verify != 'false'/);
  }
});

test('#4144: the required aggregate and credential-bearing release job are bounded', () => {
  assert.match(job(workflow('test.yml'), 'test'), /timeout-minutes:\s*5/);
  assert.match(job(workflow('release.yml'), 'release'), /timeout-minutes:\s*90/);
});
