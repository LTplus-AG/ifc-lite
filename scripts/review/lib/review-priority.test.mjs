/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The prompt-admission order (#7268), driven through the shipped fitter and
 * `buildInput` rather than a local model of either.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInput, fitFilesToPrompt, OMITTED_FOR_PROMPT_REASON } from '../build-review-input.mjs';
import { reviewTier, compareForReview, omittedByTier, REVIEW_TIERS } from './review-priority.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build-review-input.mjs');
const SHA = '42cb3751d93fa40d2da7cffa8cd9a6dca04b09f6';

/** A row whose patch is exactly `bytes` bytes. */
const row = (filename, bytes) => {
  const head = '@@ -1,1 +1,2 @@\n a\n+';
  return { filename, status: 'modified', patch: `${head}${'x'.repeat(bytes - head.length)}` };
};

const EV = 'scripts/perf/evidence/owner-cache-6537';

/**
 * The #6584 shape at head 42cb3751: the two evidence patches at their measured
 * sizes, enough further evidence that evidence ALONE exceeds the prompt, and a
 * production set totalling the measured 50,318 bytes. The filler evidence is
 * 45,000 bytes each -- larger than every production file and smaller than the
 * production total -- so largest-first necessarily leaves less room than the
 * production set needs: on the old ordering at least one production path is
 * omitted whatever the exact budget is, which is what makes this test able to
 * fail on it.
 */
function issue7268Rows() {
  const production = [
    row('apps/viewer/src/lib/geometry-cpu-buffers.ts', 20_000),
    row('apps/viewer/src/lib/geometry-cpu-aliases.ts', 15_000),
    row('apps/viewer/src/components/viewer/useFederatedGeometry.ts', 10_000),
    row('apps/viewer/src/store/slices/dataSlice.ts', 5_318),
  ];
  const tests = [
    row('apps/viewer/src/components/viewer/useFederatedGeometry.streaming.test.tsx', 20_000),
    row('apps/viewer/src/lib/geometry-cpu-appearance.test.ts', 15_000),
  ];
  const docs = [row('.changeset/bright-meshes-arrive.md', 500)];
  const evidence = [
    row(`${EV}/canonical-main2a-integration/qualification.json`, 89_519),
    row(`${EV}/canonical-main2a-integration/qualification/result.json`, 71_148),
    ...Array.from({ length: 7 }, (_, i) => row(`${EV}/filler-${i}/result.json`, 45_000)),
  ];
  // Evidence FIRST in row order, as GitHub's path-sorted listing would not put
  // it -- selection must not depend on position.
  return { production, tests, docs, evidence, rows: [...evidence, ...docs, ...tests, ...production] };
}

test('#7268: mixed production/test/evidence PR admits production and tests before evidence', () => {
  const { production, tests, docs, evidence, rows } = issue7268Rows();
  assert.equal(production.reduce((n, r) => n + Buffer.byteLength(r.patch, 'utf8'), 0), 50_318);
  const input = buildInput(rows, SHA);
  const kept = new Set(input.files.map((f) => f.path));

  for (const r of [...production, ...tests, ...docs]) {
    assert.ok(kept.has(r.filename), `${r.filename} must be reviewed before any archived evidence`);
  }
  // Evidence is still reviewed with what room is left, largest first.
  assert.ok(kept.has(`${EV}/canonical-main2a-integration/qualification.json`));
  const omitted = input.unreviewable.filter((u) => u.reason === OMITTED_FOR_PROMPT_REASON);
  assert.ok(omitted.length > 0, 'the fixture must force omissions, or there is no pressure to measure');
  for (const u of omitted) {
    assert.equal(reviewTier(u.path), 'evidence', `${u.path} is not evidence and must not be omitted here`);
    assert.equal(u.kind, 'unread', 'every omitted row must reach the marker omitted= count');
  }
  // Nothing silently dropped: every candidate is either reviewed or named.
  assert.deepEqual(
    [...kept, ...omitted.map((u) => u.path)].sort(),
    rows.map((r) => r.filename).sort(),
  );
  assert.equal(input.headSha, SHA, 'exact-head provenance is carried through unchanged');
  assert.deepEqual(input.excluded, []);
  assert.ok(evidence.length > omitted.length);
});

test('#7268: the process still says PARTIAL, names every omitted path, and states omissions by tier', () => {
  const { rows } = issue7268Rows();
  const tmp = mkdtempSync(join(tmpdir(), 'review-priority-'));
  const filesFile = join(tmp, 'files.json');
  const out = join(tmp, 'out.json');
  writeFileSync(filesFile, JSON.stringify(rows));
  const r = spawnSync(process.execPath, [SCRIPT, '--sha', SHA, '--files-file', filesFile, '--out', out], {
    encoding: 'utf8',
  });
  const log = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, log);
  // The expectation comes from the in-process build, and the CLI's emitted
  // input must be exactly that object: same rows, same head.
  const expected = buildInput(rows, SHA);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), expected);
  const omitted = expected.unreviewable.filter((u) => u.reason === OMITTED_FOR_PROMPT_REASON);
  assert.match(log, new RegExp(`::warning::.*PARTIAL REVIEW -- ${omitted.length} file`));
  assert.match(log, new RegExp(`Omitted by tier: production 0, test 0, docs-config 0, evidence ${omitted.length}\\.`));
  assert.match(log, /NOT shown to the reviewer/);
  for (const u of omitted) assert.ok(log.includes(`- ${u.path} (${OMITTED_FOR_PROMPT_REASON})`), u.path);
  assert.match(log, /head 42cb3751d/);
});

test('tiers reuse the revert-oracle taxonomy, with archived evidence matched first', () => {
  const cases = {
    'apps/viewer/src/store/slices/dataSlice.ts': 'production',
    'packages/geometry/src/index.ts': 'production',
    'rust/core/src/lib.rs': 'production',
    'scripts/review/build-review-input.mjs': 'production',
    'apps/viewer/src/lib/geometry-cpu-appearance.test.ts': 'test',
    'apps/viewer/src/test/geometry-cpu-aliases-gc.ts': 'test',
    'rust/core/tests/parse.rs': 'test',
    'docs/guide/viewer.md': 'docs-config',
    '.changeset/bright-meshes-arrive.md': 'docs-config',
    '.github/workflows/test.yml': 'production',
    '.github/actions/setup-wasm-build/action.yml': 'production',
    '.github/ISSUE_TEMPLATE/bug.md': 'docs-config',
    'scripts/perf/README.md': 'docs-config',
    'scripts/perf/evidence/owner-cache-6537/qualification.json': 'evidence',
    'docs/architecture/evidence/pdf-vector-state/control-request.json': 'evidence',
    'docs/architecture/evidence/block-scale-frame-6681/readback.mjs': 'evidence',
    'tests/evidence/x/result.json': 'evidence',
    'tools/ifcopenshell_reference/evidence/survey-volume-6533.json': 'evidence',
  };
  for (const [path, tier] of Object.entries(cases)) assert.equal(reviewTier(path), tier, path);
  assert.deepEqual(REVIEW_TIERS, ['production', 'test', 'docs-config', 'evidence']);
});

test('order: tier, then larger first, then path by code point -- host-locale independent', () => {
  const items = [
    { path: 'scripts/perf/evidence/a.json', bytes: 90_000 },
    { path: 'docs/guide/a.md', bytes: 50_000 },
    { path: 'packages/a/x.test.ts', bytes: 40_000 },
    { path: 'packages/a/b.ts', bytes: 100 },
    { path: 'packages/a/B.ts', bytes: 100 },
    { path: 'packages/a/big.ts', bytes: 30_000 },
  ];
  assert.deepEqual(items.slice().sort(compareForReview).map((i) => i.path), [
    'packages/a/big.ts',
    'packages/a/B.ts', // 'B' (0x42) before 'b' (0x62); localeCompare would invert this
    'packages/a/b.ts',
    'packages/a/x.test.ts',
    'docs/guide/a.md',
    'scripts/perf/evidence/a.json',
  ]);
});

test('the admitted set is independent of candidate order, and an equal-size tie keeps the code-point-first path', () => {
  // Two 200,000-byte production files: only one fits the prompt, so the tie
  // rule alone decides which is reviewed.
  const mk = (path, bytes) => ({ path, patch: 'y'.repeat(bytes) });
  const base = [
    mk('packages/a/a.ts', 200_000),
    mk('packages/a/B.ts', 200_000),
    mk('packages/a/c.test.ts', 30_000),
    mk('scripts/perf/evidence/e.json', 100_000),
  ];
  const results = [base, base.slice().reverse(), [base[2], base[0], base[3], base[1]]].map((c) => {
    const { kept, omitted } = fitFilesToPrompt(c, []);
    return { kept: kept.map((k) => k.path).sort(), omitted: omitted.map((o) => o.path).sort() };
  });
  for (const r of results) assert.deepEqual(r, results[0]);
  assert.deepEqual(results[0].kept, ['packages/a/B.ts', 'packages/a/c.test.ts', 'scripts/perf/evidence/e.json']);
  assert.deepEqual(results[0].omitted, ['packages/a/a.ts']);
});

test('a workflow file is reviewed before tests and evidence when the room is short', () => {
  // CI-only PRs are common here; a workflow is executable code, not config.
  // Three 200,000-byte files and room for only one: the tier alone decides,
  // and as docs-config the workflow would lose its place to the test.
  const mk = (path, bytes) => ({ path, patch: 'w'.repeat(bytes) });
  const { kept, omitted } = fitFilesToPrompt(
    [
      mk('scripts/perf/evidence/run/result.json', 200_000),
      mk('scripts/review/run-reviewer.test.mjs', 200_000),
      mk('.github/workflows/claude-review.yml', 200_000),
    ],
    [],
  );
  assert.deepEqual(kept.map((k) => k.path), ['.github/workflows/claude-review.yml']);
  assert.deepEqual(omitted.map((o) => o.path), [
    'scripts/perf/evidence/run/result.json',
    'scripts/review/run-reviewer.test.mjs',
  ]);
});

test('greedy across tiers: a production file too big for the room does not block later tiers', () => {
  const mk = (path, bytes) => ({ path, patch: 'z'.repeat(bytes) });
  const { kept, omitted } = fitFilesToPrompt(
    [mk('packages/a/giant.ts', 380_000), mk('packages/a/t.test.ts', 10_000), mk('tests/evidence/r.json', 10_000)],
    [],
  );
  assert.deepEqual(kept.map((k) => k.path), ['packages/a/t.test.ts', 'tests/evidence/r.json']);
  assert.deepEqual(omitted.map((o) => o.path), ['packages/a/giant.ts']);
});

test('omittedByTier counts every path in tier order, zeros included', () => {
  assert.equal(
    omittedByTier(['scripts/perf/evidence/a.json', 'tests/evidence/b.json', 'docs/x.md', 'packages/a/a.ts']),
    'production 1, test 0, docs-config 1, evidence 2',
  );
  assert.equal(omittedByTier([]), 'production 0, test 0, docs-config 0, evidence 0');
});
