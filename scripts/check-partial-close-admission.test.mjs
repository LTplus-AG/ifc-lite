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

// ------------------------------------------------- FINDING B: shared payload

/**
 * `--shared-state-file` is the workflow-wired path (#4180 finding B):
 * `check-issue-queue.mjs` already reads `body` and `closingIssuesReferences`
 * off the same PR event in the same job, one step earlier, and dumps it with
 * its own `--dump`. This gate is wired to read THAT file instead of taking a
 * second GraphQL round trip -- see .github/workflows/issue-queue.yml and this
 * script's own header. Unlike `--state-file` (used above, and by the test
 * harness only), a missing or unreadable shared file NEVER refuses: this
 * step's whole reason to exist is that it must not be able to fail a
 * REQUIRED job over something as ordinary as its upstream step not having
 * produced a file, since a refusal here has the exact blocking effect the
 * PR's own header says this gate must never have.
 */

test('--shared-state-file: same payload shape as --state-file, warns normally', () => {
  const file = join(TMP, `pr-${(seq += 1)}.json`);
  writeFileSync(file, JSON.stringify(payload({
    body: 'Closes #4111 (item 1 only). Not in this PR: two more items.',
    closesIssueNumber: 4111,
  })));
  const r = spawnSync('node', [GATE, '--shared-state-file', file], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PARTIAL_CLOSE_ADMISSION/);
});

test('--shared-state-file: a missing file degrades to a silent skip, exit 0, never a refusal', () => {
  const missing = join(TMP, 'does-not-exist.json');
  const r = spawnSync('node', [GATE, '--shared-state-file', missing], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SKIPPED/);
  assert.equal(r.stderr, '');
});

test('--shared-state-file: unparseable JSON degrades to a silent skip, exit 0', () => {
  const file = join(TMP, `pr-${(seq += 1)}.json`);
  writeFileSync(file, '{ not json');
  const r = spawnSync('node', [GATE, '--shared-state-file', file], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SKIPPED/);
});

test('--shared-state-file: a payload check-issue-queue.mjs could not have produced (malformed shape) degrades to a silent skip, exit 0', () => {
  const file = join(TMP, `pr-${(seq += 1)}.json`);
  writeFileSync(file, JSON.stringify({ data: { repository: { pullRequest: null } } }));
  const r = spawnSync('node', [GATE, '--shared-state-file', file], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SKIPPED/);
});

test('--shared-state-file and --state-file together is a bad-args refusal (ambiguous source)', () => {
  const file = join(TMP, `pr-${(seq += 1)}.json`);
  writeFileSync(file, JSON.stringify(payload({ closesIssueNumber: 1 })));
  const r = spawnSync('node', [GATE, '--state-file', file, '--shared-state-file', file], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BAD_ARGS/);
});
