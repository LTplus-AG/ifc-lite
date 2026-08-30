/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Regression harness for the #3443 gate as a PROCESS: real argv, real workflow
 * read, real exit codes. `scripts/lib/dirty-pr-scan.test.mjs` covers the
 * classification; this covers `--state-file` mode, which is also how CI would
 * drive this script offline if it ever needed to (it does not: the live
 * workflow always calls `gh pr list`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'scan-dirty-prs.mjs');

const TMP = mkdtempSync(join(tmpdir(), 'dirty-pr-scan-'));
let seq = 0;

function run(prs, extra = []) {
  const path = join(TMP, `state-${(seq += 1)}.json`);
  writeFileSync(path, JSON.stringify(prs));
  const r = spawnSync(process.execPath, [GATE, '--state-file', path, ...extra], { encoding: 'utf8' });
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

function lane(name) {
  return { name };
}

// The workflow's own required set at time of writing -- read once here, not
// hardcoded, so this test does not rot when test.yml's job list changes.
async function requiredLaneNames() {
  const { expandJobNames } = await import('./lib/pr-review-signal.mjs');
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(join(HERE, '../.github/workflows/test.yml'), 'utf8');
  return expandJobNames(text, { exclude: ['test'] });
}

test('RED: a #3411-shaped conflicted PR with no required lanes present fails and is named', async () => {
  const required = await requiredLaneNames();
  const { code, output } = run([
    {
      number: 3411,
      title: 'fix(core): order-independence',
      url: 'https://github.com/LTplus-AG/ifc-lite/pull/3411',
      baseRefName: 'main',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      isDraft: false,
      statusCheckRollup: [lane('Vercel Agent Review'), lane('Vercel Preview Comments')],
    },
  ]);
  assert.equal(code, 1, output);
  assert.match(output, /#3411/);
  assert.match(output, /pushing a new commit will not fix this/i);
  assert.doesNotMatch(output, /retarget the PR/i);
  assert.ok(required.includes('Node tests'));
  assert.match(output, /Node tests/);
});

test('GREEN: a clean PR with every required lane present passes', async () => {
  const required = await requiredLaneNames();
  const { code, output } = run([
    {
      number: 9001,
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      isDraft: false,
      statusCheckRollup: required.map(lane),
    },
  ]);
  assert.equal(code, 0, output);
  assert.match(output, /✅/);
});

test('GREEN: a conflicted PR whose lanes already ran (the #3417 shape) passes', async () => {
  const required = await requiredLaneNames();
  const { code, output } = run([
    {
      number: 3417,
      baseRefName: 'main',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      isDraft: false,
      statusCheckRollup: required.map(lane).concat([lane('Vercel Agent Review')]),
    },
  ]);
  assert.equal(code, 0, output);
});

test('zero open PRs passes trivially', () => {
  const { code, output } = run([]);
  assert.equal(code, 0, output);
  assert.match(output, /Scanned 0 open PR/);
});

test('fails closed rather than silently passing when the state file is not an array', () => {
  const { code, output } = run({ not: 'an array' });
  assert.equal(code, 1, output);
  assert.match(output, /BAD_INPUT/);
});

test('requires --repo or --state-file', () => {
  const r = spawnSync(process.execPath, [GATE], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: '' } });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /NO_REPO/);
});

test('RED: a stacked PR is named with the retarget remedy, never the resolve-the-conflict one', async () => {
  // The failing input from the review: #3411's real base. Before this gate read
  // `baseRefName` it printed "only resolving the conflict ... restores CI",
  // which cannot restore a lane while `test.yml` filters on `branches: [main]`.
  await requiredLaneNames();
  const { code, output } = run([
    {
      number: 3411,
      title: 'fix(core): order-independence',
      url: 'https://github.com/LTplus-AG/ifc-lite/pull/3411',
      baseRefName: 'fix-3353-snap-f32-invisible-floor',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      isDraft: false,
      statusCheckRollup: [lane('Vercel Agent Review')],
    },
  ]);
  assert.equal(code, 1, output);
  assert.match(output, /#3411/);
  assert.match(output, /retarget the PR/i, output);
  assert.doesNotMatch(output, /only resolving the conflict/i, output);
});

test('RED: a stacked PR that is fully mergeable is still reported', async () => {
  // #3405's live shape: MERGEABLE/CLEAN, 0 of 15 lanes. Nothing about a merge
  // conflict is involved, so a conflict-only gate is blind to it.
  await requiredLaneNames();
  const { code, output } = run([
    {
      number: 3405,
      baseRefName: 'fix-3338-isolate-expansion-gate',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      isDraft: false,
      statusCheckRollup: [lane('Vercel Agent Review')],
    },
  ]);
  assert.equal(code, 1, output);
  assert.match(output, /#3405/);
  assert.match(output, /retarget the PR/i, output);
});

test('RED: a stacked PR that is ALSO conflicted is told to resolve the conflict too', async () => {
  // #3411's real shape again. Retargeting it at `main` clears the base filter
  // and leaves it DIRTY, and GitHub fires no `pull_request` for a PR it cannot
  // compute a merge ref for -- so the retarget line alone sends a maintainer to
  // do half the work and get zero lanes back. Both remedies, on one run.
  await requiredLaneNames();
  const { code, output } = run([
    {
      number: 3411,
      baseRefName: 'fix-3353-snap-f32-invisible-floor',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      isDraft: false,
      statusCheckRollup: [lane('Vercel Agent Review')],
    },
  ]);
  assert.equal(code, 1, output);
  assert.match(output, /retarget the PR/i, output);
  assert.match(output, /ALSO conflicted/i, output);
  assert.match(output, /resolve the conflict as well/i, output);
});

test('a stacked PR that is NOT conflicted gets the retarget remedy only', async () => {
  // The other direction: #3405 is MERGEABLE/CLEAN, so telling it to resolve a
  // conflict it does not have would be the same wrong-remedy defect inverted.
  await requiredLaneNames();
  const { code, output } = run([
    {
      number: 3405,
      baseRefName: 'fix-3338-isolate-expansion-gate',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      isDraft: false,
      statusCheckRollup: [lane('Vercel Agent Review')],
    },
  ]);
  assert.equal(code, 1, output);
  assert.match(output, /retarget the PR/i, output);
  assert.doesNotMatch(output, /ALSO conflicted/i, output);
});

test('the scan workflow grants the check-run and commit-status reads its verdict rests on', async () => {
  // Declaring ANY `permissions:` block sets every unlisted scope to `none`, and
  // every verdict this gate reaches comes from `statusCheckRollup` -- check runs
  // and commit statuses, neither of which `pull-requests: read` covers. With
  // them missing the job either dies on `gh` or reads an empty rollup, and an
  // empty rollup makes a PR that ran all 15 lanes before going dirty (#3417,
  // #3447) indistinguishable from one that never ran any. Nothing in a local
  // run can catch that: a developer's `gh` auth is full-scope, the Actions
  // token is not, so the coupling is asserted here instead.
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(join(HERE, '../.github/workflows/dirty-pr-scan.yml'), 'utf8');
  const block = /^permissions:\n((?:[ \t]+\S.*\n|[ \t]*\n)*)/m.exec(text);
  assert.ok(block, 'dirty-pr-scan.yml declares no top-level `permissions:` block');
  const scopes = new Map();
  for (const line of block[1].split('\n')) {
    const m = /^\s+([a-z-]+):\s*(\S+)\s*$/.exec(line);
    if (m) scopes.set(m[1], m[2]);
  }
  assert.equal(scopes.get('checks'), 'read', 'the rollup carries check runs');
  assert.equal(scopes.get('statuses'), 'read', 'the rollup carries commit statuses too');
  assert.equal(scopes.get('pull-requests'), 'read', 'the scan lists open PRs');
});

test('fails closed rather than guessing a remedy when `baseRefName` is absent', () => {
  const { code, output } = run([
    { number: 3411, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', statusCheckRollup: [] },
  ]);
  assert.equal(code, 1, output);
  assert.match(output, /NO_BASE_REF/);
});
