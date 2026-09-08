/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Process-level harness for the gate itself: real argv, real exit codes,
 * driven through `--state-file` the same way `check-issue-queue.test.mjs`
 * drives `check-issue-queue.mjs` -- a captured-shape GraphQL payload, not a
 * convenient internal object, so `normalisePullRequest` is under test too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'check-partial-close-admission.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'partial-close-admission-'));
let seq = 0;

function payload({ number = 4154, title = 'Test PR', body = '', closesIssueNumber = null }) {
  return {
    data: {
      repository: {
        pullRequest: {
          number,
          title,
          body,
          closingIssuesReferences: {
            pageInfo: { hasNextPage: false },
            nodes: closesIssueNumber === null ? [] : [{ number: closesIssueNumber }],
          },
        },
      },
    },
  };
}

function run(pl) {
  const file = join(TMP, `pr-${(seq += 1)}.json`);
  writeFileSync(file, JSON.stringify(pl));
  return spawnSync('node', [GATE, '--state-file', file], { encoding: 'utf8' });
}

test('a warn-triggering PR still exits 0 (this gate never fails on the verdict)', () => {
  const r = run(payload({
    body: 'Closes #4111 (item 1 only). Not in this PR: two more items.',
    closesIssueNumber: 4111,
  }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PARTIAL_CLOSE_ADMISSION/);
  assert.match(r.stdout, /does not fail the build/);
});

test('a clean Closes #N exits 0 and prints CLEAN', () => {
  const r = run(payload({ body: 'Closes #100. Fully fixes the bug.', closesIssueNumber: 100 }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /CLEAN/);
});

test('a PR with no closing reference exits 0 and prints NO_CLOSING_KEYWORD', () => {
  const r = run(payload({ body: 'Refs #100. Does not address the rest.', closesIssueNumber: null }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /NO_CLOSING_KEYWORD/);
});

test('a missing pullRequest is a refusal: exits 1, not a silent pass', () => {
  const file = join(TMP, `pr-${(seq += 1)}.json`);
  writeFileSync(file, JSON.stringify({ data: { repository: { pullRequest: null } } }));
  const r = spawnSync('node', [GATE, '--state-file', file], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NO_PULL_REQUEST/);
});

test('a payload missing closingIssuesReferences entirely is a refusal, not "closes nothing"', () => {
  const file = join(TMP, `pr-${(seq += 1)}.json`);
  writeFileSync(
    file,
    JSON.stringify({ data: { repository: { pullRequest: { number: 1, title: 't', body: 'x' } } } }),
  );
  const r = spawnSync('node', [GATE, '--state-file', file], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NO_CLOSING_ISSUES/);
});

test('bad args refuse with exit 1', () => {
  const r = spawnSync('node', [GATE, '--nonsense'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BAD_ARGS/);
});
