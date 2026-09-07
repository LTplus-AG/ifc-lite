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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requiredWorkflowTriggers } from './lib/workflow-triggers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'scan-dirty-prs.mjs');

const TMP = mkdtempSync(join(tmpdir(), 'dirty-pr-scan-'));
let seq = 0;

function run(prs, { workflow = workflowFixture(), extra = [] } = {}) {
  const path = join(TMP, `state-${(seq += 1)}.json`);
  writeFileSync(path, JSON.stringify(prs));
  // GITHUB_STEP_SUMMARY is blanked so a gate spawned under a real CI job does
  // not append fixture findings to that job's actual step summary; the gate
  // treats '' as "no summary file".
  const r = spawnSync(process.execPath, [GATE, '--workflow', workflow, '--state-file', path, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
  });
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

test('the harness does not leak fixture findings into the ambient GITHUB_STEP_SUMMARY', () => {
  // The gate defaults its summary file from GITHUB_STEP_SUMMARY, so a `run()`
  // that inherits the ambient environment appends every fixture's fake
  // findings to the REAL step summary of whatever CI job runs this test file.
  const summary = join(TMP, `ambient-summary-${(seq += 1)}.md`);
  writeFileSync(summary, '');
  const prev = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summary;
  try {
    const { code } = run([]);
    assert.equal(code, 0);
  } finally {
    if (prev === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = prev;
  }
  assert.equal(readFileSync(summary, 'utf8'), '');
});

test('fails closed rather than silently passing when the state file is not an array', () => {
  const { code, output } = run({ not: 'an array' });
  assert.equal(code, 2, output);
  assert.match(output, /BAD_INPUT/);
});

test('requires --repo or --state-file', () => {
  const r = spawnSync(process.execPath, [GATE], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: '' } });
  assert.equal(r.status, 2);
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
  assert.equal(code, 2, output);
  assert.match(output, /NO_BASE_REF/);
});

// ── 1 MEANS "LOOKED AND FOUND"; 2 MEANS "COULD NOT LOOK" ──────────────────
//
// The whole point of the split. A caller acts on the finding -- it labels the
// PRs the scan named and CLEARS the label from every PR it did not -- so
// conflating the two lets a transient HTTP 502 read as "no PR is silent any
// more" and strip the label off PRs that are still broken. Pinned in both
// directions, because a split that only ever produces one of the codes is not
// a split.
test('exit 1 is a FINDING and exit 2 is a FAILURE TO LOOK, and they never collide', () => {
  const finding = run([
    { number: 1, baseRefName: 'feature/x', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [] },
  ]);
  assert.equal(finding.code, 1, finding.output);
  assert.match(finding.output, /silent-prs=1/);

  const cannotLook = run({ not: 'an array' });
  assert.equal(cannotLook.code, 2, cannotLook.output);
  // And it must NOT publish a silent set, because it never computed one. An
  // empty `silent-prs=` here would be read as "nothing is silent".
  assert.doesNotMatch(cannotLook.output, /silent-prs=/);
});

// ── THE MACHINE LINE IS THE SET THE REPORT CALLS SILENT ───────────────────
//
// Not the human lines. Screen-scraping those also picked up the
// `unknownAdvisory` block -- PRs deliberately excluded from `silent` because
// they re-check themselves -- so a freshly opened PR was labelled and
// unlabelled every 30 minutes.
test('silent-prs excludes the advisory UNKNOWN class the report prints separately', () => {
  const { code, output } = run([
    { number: 77, baseRefName: 'main', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', statusCheckRollup: [] },
  ]);
  assert.equal(code, 0, output);
  assert.match(output, /silent-prs=$/m);
});

// ------------------------------------- a matrix job skipped BEFORE expanding (#3584 shape)

// The literal `${{ }}` below is DATA, not a template this file means to interpolate: it is what
// GitHub publishes as the check-run name for a matrix job skipped before it expanded.
// oxlint-disable-next-line no-template-curly-in-string
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

// ------------------------------------------------- the scan's own liveness

test('the scan has a trigger that does not depend on GitHub cron delivery', () => {
  // #3776: `gh run list --workflow "Silent PR CI visibility"` showed ONE run in
  // total, four hours into a 30-minute cron, so the only thing on `main` was
  // that run's four-hour-old failure -- naming PRs that had since been
  // retargeted and gone green. A scheduled trigger is best-effort, and a
  // workflow whose output is read as a `main` health signal cannot rest on one
  // alone: a stale failure and a live one are the same row in the workflow
  // list. The GAP REPORT is a pure function, tested in
  // scripts/lib/dirty-pr-scan.test.mjs; this is the one thing about it that
  // only the YAML can answer.
  //
  // Asserted against the PARSED trigger list (`requiredWorkflowTriggers`,
  // scripts/lib/workflow-triggers.mjs) rather than the workflow's raw text --
  // a source-text regex match here is exactly what
  // scripts/check-source-text-assertions.mjs (#2434) exists to ratchet out.
  const triggers = requiredWorkflowTriggers(join(HERE, '..', '.github/workflows/dirty-pr-scan.yml'));
  assert.ok(triggers.includes('workflow_dispatch'), 'the scan must be startable by hand');
  assert.ok(
    triggers.includes('push'),
    'the scan must also fire on a real repository event, not on `schedule` alone',
  );
});
