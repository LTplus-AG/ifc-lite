/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/perf/instructions-replay.mjs --report (#6958).
 *
 * The replay's job is to say, per ledger entry, whether the instruction-count
 * direction agrees with the recorded end-to-end verdict. What these tests pin:
 *   - a delta below the flat threshold (1e-4) is "flat", so per-process hash
 *     seed noise can never read as a win or a loss, and a scheduling-only
 *     change that leaves the work alone "tracks" by staying flat;
 *   - a direction that disagrees with the ledger is reported as not tracking,
 *     never rounded into agreement;
 *   - a side that could not be built stays "not replayed" with its reason,
 *     never a number;
 *   - an output-count change between the sides is flagged next to the verdict.
 *
 * Driven through the CLI as a child process over a recorded results file, the
 * way the evidence is re-rendered. Assertion messages never echo the child's
 * stderr.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./instructions-replay.mjs', import.meta.url));
const COUNTS = { meshes: 10, vertices: 300, triangles: 100 };
const side = (ir, counts = COUNTS) => ({ ir, ...counts });

function candidate(id, cls, expect, before, after) {
  return {
    id, class: cls, expect, title: id, ledger: 'recorded verdict',
    before: { ref: 'aaa' }, after: { ref: 'bbb' },
    fixtures: [{ fixture: 'tests/models/ara3d/AC20-FZK-Haus.ifc', before, after }],
  };
}

function report(candidates, definitions) {
  const dir = mkdtempSync(join(tmpdir(), 'instructions-replay-'));
  try {
    const path = join(dir, 'results.json');
    writeFileSync(path, JSON.stringify({ candidates }));
    const args = [CLI, '--report', path];
    if (definitions) {
      writeFileSync(join(dir, 'candidates.json'), JSON.stringify({ candidates: definitions }));
      args.push('--candidates', join(dir, 'candidates.json'));
    }
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000 });
    const rows = new Map(r.stdout.split('\n').filter((l) => /^\| [a-z0-9-]+ \|/.test(l) && !l.startsWith('| candidate'))
      .map((l) => [l.split('|')[1].trim(), l]));
    return { status: r.status, rows };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a win that retires fewer instructions tracks', () => {
  const { status, rows } = report([candidate('win', 'win', 'fewer', side(1_000_000_000), side(600_000_000))]);
  assert.equal(status, 0, 'the report CLI must succeed');
  const row = rows.get('win') ?? '';
  assert.ok(row.includes('-40.000%'), 'the relative delta must be shown');
  assert.ok(/\| fewer \| tracks \|$/.test(row), 'fewer instructions for a win must track');
});

test('a delta inside the flat threshold is flat: scheduling-only tracks, a claimed win does not', () => {
  // 5e-5 relative: above the measured hash-seed noise, below the 1e-4 threshold.
  const before = side(1_000_000_000);
  const after = side(1_000_050_000);
  const { rows } = report([
    candidate('sched', 'scheduling', 'flat', before, after),
    candidate('claimed', 'win', 'fewer', before, after),
  ]);
  assert.ok(/\| flat \| flat \| tracks \|$/.test(rows.get('sched') ?? ''), 'unchanged work must track a scheduling change');
  assert.ok(/\| fewer \| flat \| does-not-track \|$/.test(rows.get('claimed') ?? ''), 'a flat count must not track a claimed win');
});

test('a dead end whose count went the other way does not track', () => {
  const { rows } = report([candidate('dead', 'dead-end', 'more', side(1_000_000), side(990_000))]);
  assert.ok(/\| more \| fewer \| does-not-track \|$/.test(rows.get('dead') ?? ''), 'disagreement must be reported');
});

test('an unbuilt side is not replayed and keeps its reason', () => {
  const { rows } = report([candidate('old', 'win', 'fewer', { error: 'build failed at aaa' }, side(5))]);
  const row = rows.get('old') ?? '';
  assert.ok(row.includes('not replayed: build failed at aaa'), 'the reason must be kept');
  assert.ok(!/\d+\.\d+M/.test(row), 'no number may be shown for an unmeasured side');
});

test('an output-count change is flagged next to the verdict', () => {
  const { rows } = report([candidate('diff', 'win', 'fewer', side(100), side(50, { ...COUNTS, triangles: 99 }))]);
  assert.ok((rows.get('diff') ?? '').includes('(output counts changed)'), 'changed output must be flagged');
});

test('a fixture outside the ledger claim is shown but not judged', () => {
  const c = { ...candidate('ctx', 'win', 'fewer', side(100), side(200)), claims: ['tests/models/ara3d/ISSUE_129.ifc'] };
  const row = report([c]).rows.get('ctx') ?? '';
  assert.ok(row.includes('+100.000%'), 'the count must still be shown');
  assert.ok(/\| more \| no ledger claim \|$/.test(row), 'an unclaimed fixture must not get a tracks/does-not-track verdict');
});

test('--candidates re-judges recorded counts against corrected expectations', () => {
  const recorded = candidate('fix', 'dead-end', 'fewer', side(1_000_000), side(1_100_000));
  const { rows } = report([recorded], [{ id: 'fix', expect: 'more' }]);
  assert.ok(/\| more \| more \| tracks \|$/.test(rows.get('fix') ?? ''), 'the definition file must supply the expectation');
});

test('a delta inside the two sides\' measured run-to-run spread is flat', () => {
  // 5e-4 apart, but each side repeats only to 4e-4: no direction can be read.
  const before = { ...side(1_000_000_000), runs: [999_800_000, 1_000_000_000, 1_000_200_000] };
  const after = { ...side(1_000_500_000), runs: [1_000_300_000, 1_000_500_000, 1_000_700_000] };
  const row = report([candidate('noisy', 'win', 'fewer', before, after)]).rows.get('noisy') ?? '';
  assert.ok(row.includes('±0.080%'), 'the flat band must be the combined spread');
  assert.ok(/\| fewer \| flat \| does-not-track \|$/.test(row), 'a delta inside the spread must be flat');
});

test('a replay that could not measure a fixture exits nonzero; a measured disagreement does not', () => {
  const failed = report([candidate('broken', 'win', 'fewer', { error: 'build failed' }, side(900))]);
  assert.equal(failed.status, 3, 'a not-replayed fixture must not read as success');
  const disagrees = report([candidate('dead', 'dead-end', 'more', side(1000), side(900))]);
  assert.equal(disagrees.status, 0, 'does-not-track is a verdict, not a tool failure');
});

test('--jobs and --runs reject non-positive or non-numeric values instead of hanging', () => {
  for (const [flag, value] of [['--jobs', '0'], ['--runs', '0'], ['--runs', 'many']]) {
    const r = spawnSync(process.execPath, [CLI, '--candidates', 'unused.json', '--out', 'unused.json', flag, value],
      { encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.status, 2, `${flag} ${value} must be rejected`);
    assert.ok(r.stderr.includes(`${flag} must be a positive integer`), `${flag} ${value} must say why`);
  }
});
