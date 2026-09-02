/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Regression harness for the #3443 gate as a process: real argv, workflow
 * fixtures, and real exit codes. `scripts/lib/dirty-pr-scan.test.mjs` covers
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

function run(prs, { workflow = workflowFixture(), extra = [] } = {}) {
  const path = join(TMP, `state-${(seq += 1)}.json`);
  writeFileSync(path, JSON.stringify(prs));
  const r = spawnSync(process.execPath, [GATE, '--workflow', workflow, '--state-file', path, ...extra], { encoding: 'utf8' });
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

function lane(name) {
  return { name };
}

function workflowFixture({ branches = '[main]', nodeJob = 'node' } = {}) {
  const path = join(TMP, `workflow-${(seq += 1)}.yml`);
  writeFileSync(
    path,
    `on:\n  pull_request:\n    branches: ${branches}\njobs:\n  lint:\n    name: Lint\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n  ${nodeJob}:\n    name: Node tests\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n`,
  );
  return path;
}

const REQUIRED = ['Lint', 'Node tests'];

test('RED: a #3411-shaped conflicted PR with no required lanes present fails and is named', () => {
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
  assert.match(output, /Node tests/);
});

test('GREEN: a clean PR with every required lane present passes', () => {
  const { code, output } = run([
    {
      number: 9001,
      baseRefName: 'main',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      isDraft: false,
      statusCheckRollup: REQUIRED.map(lane),
    },
  ]);
  assert.equal(code, 0, output);
  assert.match(output, /✅/);
});

test('GREEN: a conflicted PR whose lanes already ran (the #3417 shape) passes', () => {
  const { code, output } = run([
    {
      number: 3417,
      baseRefName: 'main',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      isDraft: false,
      statusCheckRollup: REQUIRED.map(lane).concat([lane('Vercel Agent Review')]),
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

test('RED: a stacked PR is named with the retarget remedy, never the resolve-the-conflict one', () => {
  // The failing input from the review: #3411's real base. Before this gate read
  // `baseRefName` it printed "only resolving the conflict ... restores CI",
  // which cannot restore a lane while `test.yml` filters on `branches: [main]`.
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

test('RED: a stacked PR that is fully mergeable is still reported', () => {
  // #3405's live shape: MERGEABLE/CLEAN, 0 of 15 lanes. Nothing about a merge
  // conflict is involved, so a conflict-only gate is blind to it.
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

test('RED: a stacked PR that is ALSO conflicted is told to resolve the conflict too', () => {
  // #3411's real shape again. Retargeting it at `main` clears the base filter
  // and leaves it DIRTY, and GitHub fires no `pull_request` for a PR it cannot
  // compute a merge ref for -- so the retarget line alone sends a maintainer to
  // do half the work and get zero lanes back. Both remedies, on one run.
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

test('a stacked PR that is NOT conflicted gets the retarget remedy only', () => {
  // The other direction: #3405 is MERGEABLE/CLEAN, so telling it to resolve a
  // conflict it does not have would be the same wrong-remedy defect inverted.
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

test('reads required lanes and base filters from the supplied workflow fixture', () => {
  const { code, output } = run(
    [{ number: 3411, baseRefName: 'release', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [] }],
    { workflow: workflowFixture({ branches: '[main, release]', nodeJob: 'web' }) },
  );
  assert.equal(code, 0, output);
  assert.match(output, /Scanned 1 open PR\(s\) against 2 required lane\(s\)/);
});

test('fails closed rather than guessing a remedy when `baseRefName` is absent', () => {
  const { code, output } = run([
    { number: 3411, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', statusCheckRollup: [] },
  ]);
  assert.equal(code, 1, output);
  assert.match(output, /NO_BASE_REF/);
});

// ------------------------------------- a matrix job skipped BEFORE expanding (#3584 shape)

const MATRIX_TEMPLATE = 'Viewer tests (shard ${{ matrix.shard }})';

function matrixWorkflowFixture() {
  const path = join(TMP, `workflow-${(seq += 1)}.yml`);
  writeFileSync(
    path,
    `on:\n  pull_request:\n    branches: [main]\njobs:\n  lint:\n    name: Lint\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n  viewer-tests:\n    name: ${MATRIX_TEMPLATE}\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        shard: [0, 1, 2, 3]\n    steps:\n      - run: true\n`,
  );
  return path;
}

test('GREEN: a matrix job skipped wholesale before expanding is not silent CI (the #3581 shape)', () => {
  // Measured on PR #3581: a docs/scripts/config-only change (no `frontend` or
  // `rust` paths touched) skips `viewer-tests` via `if:` before its
  // `strategy.matrix` fans out, so GitHub publishes ONE check run under the
  // unexpanded template -- never `Viewer tests (shard 0)`..`(shard 3)`, the
  // names `expandJobNames` derives. Before this scan reused
  // `pr-review-signal.mjs`'s alias-aware `missingLanes`, its own local,
  // plain-membership version could never match those four names against
  // anything, so a conflicted PR of this shape misreported `CONFLICTED` even
  // though every lane the workflow actually publishes had run.
  const { code, output } = run(
    [
      {
        number: 3581,
        baseRefName: 'main',
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        isDraft: false,
        statusCheckRollup: [
          { name: 'Lint', state: 'success' },
          { name: MATRIX_TEMPLATE, state: 'skipped' },
        ],
      },
    ],
    { workflow: matrixWorkflowFixture() },
  );
  assert.equal(code, 0, output);
  assert.match(output, /✅/, output);
});
