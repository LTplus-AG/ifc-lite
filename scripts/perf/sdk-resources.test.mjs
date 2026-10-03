/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuReading, cpuIntervals } from './sdk-resources.mjs';
import { classifyBuildTestProcess } from './sdk-process-classification.mjs';
function readings(busy = 10n, idle = 90n) {
  return Array.from({ length: 4 }, (_unused, index) => {
    const step = BigInt(index);
    return cpuReading(`cpu ${busy * step} 0 0 ${idle * step} 0 0 0 0 999 999\ncpu0 1 2 3 4`, step * 1000000000n);
  });
}
test('#6537 Linux CPU intervals use fresh aggregate deltas, exclude duplicate guest fields and include iowait', () => {
  const rows = readings(), intervals = cpuIntervals(rows);
  assert.equal(rows[3].total, '300'); assert.equal(intervals.length, 3);
  assert.ok(intervals.every(item => item.eligible && item.totalTicks === '100' && item.elapsedNs === '1000000000'));
  const wait = cpuReading('cpu 1 0 0 80 10 0 0 0 100 0', 0n); assert.equal(wait.idle, '90'); assert.equal(wait.total, '91');
});
test('#6537 CPU gate preserves exact 10% boundary at large integer tick totals', () => {
  assert.ok(cpuIntervals(readings()).every(item => item.eligible));
  assert.ok(cpuIntervals(readings(11n, 89n)).every(item => !item.eligible));
  const scale = 900719925474099n;
  assert.ok(cpuIntervals(readings(scale, scale * 9n)).every(item => item.eligible));
  assert.ok(cpuIntervals(readings(scale + 1n, scale * 9n - 1n)).every(item => !item.eligible));
});
test('#6537 missing, stale and invalid CPU counters refuse rather than estimate idle', () => {
  assert.throws(() => cpuReading('cpu0 1 2 3 4', 0n));
  assert.throws(() => cpuIntervals(readings().slice(1)));
  for (const change of [rows => { rows[1].monotonicNs = '999999999'; }, rows => { rows[1].total = '0'; },
    rows => { rows[1].idle = '101'; }, rows => { rows[1].total = '9007199254740992'; }]) {
    const rows = readings(); change(rows); assert.throws(() => cpuIntervals(rows));
  }
});
test('#6537 observable graph classifier refuses actual tool/task entries without matching remembered guardian payloads', () => {
  for (const argv of [['node', '/x/tsc.js', '--noEmit'], ['pnpm', '--dir', '/x', 'run', 'build'],
    ['node', '/x/sdk-plan.test.mjs', '--test'], ['node', '--test', 'scripts/perf/sdk-plan.test.mjs'], ['cargo', 'test']]) {
    if (argv[1] === '/x/sdk-plan.test.mjs') assert.equal(classifyBuildTestProcess(argv), null);
    else assert.ok(classifyBuildTestProcess(argv));
  }
  assert.equal(classifyBuildTestProcess(['node', 'scripts/perf/sdk-sample.mjs', 'build', 'cargo']), null);
  assert.equal(classifyBuildTestProcess(['python3', 'guardian.py', '--child-command', 'cargo test']), null);
});
