/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Real-GPU frame rig CLI contract (#6960): the parts that run without a
// browser. Black-box through the CLI, the way an operator runs it.
//   node --test scripts/perf/frame-gpu-rig.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

function rig(...args) {
  const run = spawnSync(TSX, ['scripts/perf/frame-gpu-rig.mts', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, `frame-gpu-rig ${args.join(' ')} exited ${run.status}`);
  return JSON.parse(run.stdout);
}

test('base and branch alternate in counterbalanced pairs, so neither side always runs first', () => {
  const plan = rig('--plan', '--pairs', '4', '--dist-base', 'apps/viewer');
  assert.deepEqual(plan.map((s) => `${s.pair}${s.side[1]}`), ['0a', '0r', '1r', '1a', '2a', '2r', '3r', '3a']);
  assert.deepEqual(rig('--plan', '--pairs', '2').map((s) => s.side), ['branch', 'branch']);
});

test('the verdict is the median per-pair ratio, not a ratio of cross-session medians', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frame-gpu-rig-'));
  try {
    const row = (value) => [{ fixture: 'm', scenario: 'orbit', metric: 'raf_delta_ms_p95', value }];
    // Session drift: pair 1 runs on a machine twice as slow, but branch is
    // 10% faster than base within every pair. A failed sample drops out with
    // its pair's ratio rather than skewing it.
    const samples = [
      { pair: 0, side: 'base', ok: true, rows: row(10) }, { pair: 0, side: 'branch', ok: true, rows: row(9) },
      { pair: 1, side: 'branch', ok: true, rows: row(18) }, { pair: 1, side: 'base', ok: true, rows: row(20) },
      { pair: 2, side: 'base', ok: true, rows: row(10) }, { pair: 2, side: 'branch', ok: false, error: 'x', rows: row(1) },
    ];
    const jsonl = join(dir, 'runs.jsonl');
    writeFileSync(jsonl, samples.map((s) => JSON.stringify(s)).join('\n'));
    const [summary] = rig('--summarize', jsonl, '--json');
    assert.equal(summary.pairedRatio, 0.9);
    assert.equal(summary.pairs, 2);
    assert.deepEqual(summary.base, { median: 10, min: 10, max: 20, n: 3 });
    assert.deepEqual(summary.branch, { median: 9, min: 9, max: 18, n: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// #7005: actual CLI refusals happen before any physical-session/browser work.
// A missing model is a deliberate downstream stop even if admission regresses.
test('#7005 frame rig admits both source revisions before touching model or host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frame-span-source-'));
  const minimum = '272ebd8615d038dc20dd8aec4e3bb88d1acf9fa7';
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const head = git('rev-parse', 'HEAD');
  const previous = git('rev-parse', `${minimum}^`);
  const receipt = join(dir, 'source-revisions.json');
  const run = (...args) => spawnSync(TSX, ['scripts/perf/frame-gpu-rig.mts',
    join(dir, 'missing.ifc'), '--out-dir', dir, ...args],
    { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
  try {
    for (const args of [[], ['--branch-revision', previous],
      ['--branch-revision', head, '--dist-base', dir],
      ['--branch-revision', head, '--dist-base', dir, '--base-revision', previous]]) {
      const result = run(...args);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /source revision is required|must include #6979/);
      assert.doesNotMatch(result.stderr, /model not found/);
      assert.equal(existsSync(receipt), false, 'inadmissible sources must not receive a receipt');
    }
    for (const base of [false, true]) {
      const result = run('--branch-revision', 'HEAD', ...(base
        ? ['--dist-base', dir, '--base-revision', minimum] : []));
      assert.ifError(result.error);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /model not found/);
      assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), {
        branch: head, base: base ? minimum : null,
      });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
