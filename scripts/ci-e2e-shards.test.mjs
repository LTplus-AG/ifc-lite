/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/ci-e2e-shards.mjs, driven as the workflow drives it (the CLI, then
 * the workflow step itself): the eight `Viewer E2E smoke` shards PARTITION the
 * files the `viewer-e2e-ci` project selects, stay balanced under the measured
 * durations, and refuse a stale table rather than silently run less.
 *
 * Only the CLI is reached, never the module's exports: a changed test that
 * imports a module main lacks cannot load once the revert oracle removes it,
 * and then no assertion runs. Spawning a missing CLI fails an assertion.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts/ci-e2e-shards.mjs');
const CAP_S = 13 * 60;

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

/** The project's testMatch applied to tests/e2e, independently of the CLI's own read. */
function expectedFiles() {
  const config = readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8');
  const re = new RegExp(config.match(/name: 'viewer-e2e-ci',\s*testMatch: \/(.+)\/,/)[1]); // @source-text-assertion-ok the project's testMatch is matched against file paths and the CLI's stderr is its subject; no source text is asserted
  const out = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (re.test(p)) out.push(relative(ROOT, p)); // @source-text-assertion-ok the project's testMatch is matched against file paths and the CLI's stderr is its subject; no source text is asserted
    }
  })(join(ROOT, 'tests/e2e'));
  return out.sort();
}

const plan = () => {
  const res = cli('--plan');
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
};

/** A tree with the project's config and the given spec files, plus a timing table. */
function fixture(files, timings) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-shards-'));
  mkdirSync(join(root, 'tests/e2e'), { recursive: true });
  writeFileSync(join(root, 'playwright.config.ts'), "projects: [{\n      name: 'viewer-e2e-ci',\n      testMatch: /(alpha|beta|gamma)\\.e2e\\.spec\\.ts/,\n      timeout: 1,\n}]\n");
  for (const f of files) writeFileSync(join(root, 'tests/e2e', f), '');
  writeFileSync(join(root, 'timings.json'), JSON.stringify(timings));
  return root;
}

test('the 8 shards partition the selected files: union equals the set, no duplicates, none empty', () => {
  const expected = expectedFiles();
  assert.ok(expected.length > 50, `only ${expected.length} files expected; the test's testMatch read is wrong`);
  const shards = plan();
  assert.equal(shards.length, 8);
  const all = shards.flatMap((s) => s.files);
  assert.equal(new Set(all).size, all.length, 'a file landed in two shards');
  assert.deepEqual([...all].sort(), expected);
  for (const [i, s] of shards.entries()) assert.ok(s.files.length > 0, `shard ${i + 1} is empty`);
});

test('the filters each shard prints select exactly that shard\'s files', () => {
  const shards = plan();
  const expected = expectedFiles();
  for (let n = 1; n <= 8; n++) {
    const res = cli('--shard', `${n}/8`);
    assert.equal(res.status, 0, res.stderr);
    const regexes = res.stdout.trim().split('\n').map((f) => new RegExp(f));
    const picked = expected.filter((file) => regexes.some((re) => re.test(join(ROOT, file)))); // @source-text-assertion-ok the project's testMatch is matched against file paths and the CLI's stderr is its subject; no source text is asserted
    assert.deepEqual(picked, shards[n - 1].files, `shard ${n}`);
  }
});

test('predicted shard durations are balanced and far under the 13-minute cap', () => {
  const loads = plan().map((s) => s.seconds);
  const max = Math.max(...loads);
  assert.ok(max < 9 * 60, `heaviest shard predicts ${Math.round(max / 60)} min`);
  assert.ok(max - Math.min(...loads) < 90, `shards differ by ${Math.round(max - Math.min(...loads))} s`);
  assert.ok(max < CAP_S);
});

test('a spec with no timing is not dropped: it runs on the lightest shard', () => {
  const root = fixture(['alpha.e2e.spec.ts', 'beta.e2e.spec.ts', 'gamma.e2e.spec.ts'], { 'tests/e2e/alpha.e2e.spec.ts': 100 });
  try {
    const shards = JSON.parse(cli('--plan', '--root', root, '--timings', join(root, 'timings.json')).stdout);
    assert.deepEqual(shards[0].files, ['tests/e2e/alpha.e2e.spec.ts']);
    assert.deepEqual(shards.flatMap((s) => s.files).sort(), ['tests/e2e/alpha.e2e.spec.ts', 'tests/e2e/beta.e2e.spec.ts', 'tests/e2e/gamma.e2e.spec.ts']);
    assert.ok(shards[1].files.length === 1 && shards[2].files.length === 1, 'unmeasured files spread over empty shards');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a timing entry for a file the project no longer selects makes the CLI refuse', () => {
  const root = fixture(['alpha.e2e.spec.ts'], { 'tests/e2e/alpha.e2e.spec.ts': 5, 'tests/e2e/gone.e2e.spec.ts': 5 });
  try {
    const res = cli('--shard', '1/8', '--root', root, '--timings', join(root, 'timings.json'));
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^::error::ci-e2e-shards:.*gone\.e2e\.spec\.ts/); // @source-text-assertion-ok the project's testMatch is matched against file paths and the CLI's stderr is its subject; no source text is asserted
    assert.equal(res.stdout, '', 'a refusal must print no filter (the step would run unfiltered)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shard specs outside 1..8 or for another matrix size are refused', () => {
  assert.equal(cli('--shard', '3/8').status, 0);
  for (const bad of ['0/8', '9/8', '3/4', '3', 'x/8']) {
    const res = cli('--shard', bad);
    assert.equal(res.status, 1, bad);
    assert.match(res.stderr, /^::error::ci-e2e-shards:/); // @source-text-assertion-ok the project's testMatch is matched against file paths and the CLI's stderr is its subject; no source text is asserted
  }
});

test('a filter selects exactly its own file, not a longer name that contains it', () => {
  const root = fixture(['alpha.e2e.spec.ts', 'beta.e2e.spec.ts'], { 'tests/e2e/alpha.e2e.spec.ts': 5, 'tests/e2e/beta.e2e.spec.ts': 4 });
  try {
    // Lookalikes the unanchored testMatch would also select.
    writeFileSync(join(root, 'tests/e2e/x-alpha.e2e.spec.ts'), '');
    const res = cli('--shard', '1/8', '--root', root, '--timings', join(root, 'timings.json'));
    assert.equal(res.status, 0, res.stderr);
    const re = new RegExp(res.stdout.trim());
    assert.ok(re.test(join(root, 'tests/e2e/alpha.e2e.spec.ts'))); // @source-text-assertion-ok the project's testMatch is matched against file paths and the CLI's stderr is its subject; no source text is asserted
    assert.ok(!re.test(join(root, 'tests/e2e/alpha.e2e.spec.ts.bak'))); // @source-text-assertion-ok the project's testMatch is matched against file paths and the CLI's stderr is its subject; no source text is asserted
    assert.ok(!re.test(join(root, 'tests/e2e/alphaXe2eXspecXts'))); // @source-text-assertion-ok the project's testMatch is matched against file paths and the CLI's stderr is its subject; no source text is asserted
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a config without the project is refused, not read as an empty selection', () => {
  const root = fixture([], {});
  try {
    writeFileSync(join(root, 'playwright.config.ts'), 'export default {}');
    const res = cli('--shard', '1/8', '--root', root, '--timings', join(root, 'timings.json'));
    assert.equal(res.status, 1);
    assert.equal(res.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the workflow step, run for matrix shard 3, hands pnpm exactly that shard\'s filters and no --shard', () => {
  const steps = parse(readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')).jobs['viewer-e2e'].steps;
  const step = steps.find((s) => s.id === 'e2e');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-step-'));
  try {
    // A stub pnpm records its argv; the real timeout and bash run the step.
    writeFileSync(join(dir, 'pnpm'), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done > "$RECORD"\n');
    chmodSync(join(dir, 'pnpm'), 0o755);
    const script = step.run.replaceAll('${{ matrix.shard }}', '3').replace(/\$\{\{[^}]*\}\}/g, ''); // eslint-disable-line no-template-curly-in-string
    const res = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, RUNNER_TEMP: dir, RECORD: join(dir, 'argv') },
    });
    assert.equal(res.status, 0, res.stderr);
    const argv = readFileSync(join(dir, 'argv'), 'utf8').trim().split('\n');
    const filters = cli('--shard', '3/8').stdout.trim().split('\n');
    assert.deepEqual(argv.slice(0, 1 + filters.length), ['test:e2e:ci', ...filters]);
    assert.deepEqual(argv.filter((a) => a.startsWith('--shard')), [], 'Playwright --shard is back'); // @source-text-assertion-ok the project's testMatch is matched against file paths and the CLI's stderr is its subject; no source text is asserted
    assert.deepEqual(argv.filter((a) => a.startsWith('--reporter=list')).length, 1); // @source-text-assertion-ok the project's testMatch is matched against file paths and the CLI's stderr is its subject; no source text is asserted
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const retry = steps.find((s) => s.id === 'e2e_retry');
  assert.equal(retry.env.E2E_SHARD, '${{ matrix.shard }}/8'); // eslint-disable-line no-template-curly-in-string
});
