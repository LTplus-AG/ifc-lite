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
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      isDraft: false,
      statusCheckRollup: [lane('Vercel Agent Review'), lane('Vercel Preview Comments')],
    },
  ]);
  assert.equal(code, 1, output);
  assert.match(output, /#3411/);
  assert.match(output, /pushing a new commit will not fix this/i);
  assert.ok(required.includes('Node tests'));
  assert.match(output, /Node tests/);
});

test('GREEN: a clean PR with every required lane present passes', async () => {
  const required = await requiredLaneNames();
  const { code, output } = run([
    {
      number: 9001,
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
