/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuReading, cpuIntervals, waitUntil, qualifyCPU, processObservation, noBuildGraphs } from './sdk-resources.mjs';
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freshnessException, cargoArgs } from './native-hosted-plan.mjs';
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
test('#6537 early timer wakes cannot shorten the measured one-second CPU interval', async () => {
  let elapsed = 0n;
  const advances = [999500000n, 200000n, 300000n], requested = [];
  await waitUntil(1000000000n, () => elapsed, async milliseconds => {
    requested.push(milliseconds);
    assert.ok(advances.length, 'deadline must terminate once the minimum interval is met');
    elapsed += advances.shift();
  });
  assert.ok(elapsed >= 1000000000n);
  assert.deepEqual(requested, [1000, 1, 1]);
});
test('#6537 counter provenance and busy-CPU refusals retain all untouched raw readings', () => {
  for (const rows of [readings(), readings(11n, 89n)]) {
    if (rows[1].idle === '90') rows[1].monotonicNs = '999999999';
    const evidence = { rows, before: { active: [] }, after: { active: [] } };
    let refused;
    try { qualifyCPU(evidence); } catch (error) { refused = error; }
    assert.ok(refused, 'unsafe CPU observations must refuse');
    assert.deepEqual(refused.receipt.rows, rows);
    assert.equal(refused.receipt.status, 'refused');
    assert.deepEqual(JSON.parse(refused.message.slice(refused.message.indexOf('{'))).rows, rows);
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
function withProcessFiles(argv, options, run) {
  const directory = mkdtempSync(join(tmpdir(), 'proc-observation-'));
  const failure = code => Object.assign(new Error(`kernel boundary ${code}`), { code });
  try {
    writeFileSync(join(directory, 'cmdline'), argv.join('\0') + '\0');
    symlinkSync(options.executable ?? '/usr/bin/systemd', join(directory, 'exe'));
    const io = {
      readFile: (_path, encoding) => { if (options.cmdlineError) throw failure(options.cmdlineError); return readFileSync(join(directory, 'cmdline'), encoding); },
      readLink: () => { if (options.exeError) throw failure(options.exeError); return readlinkSync(join(directory, 'exe')); },
    };
    run(() => processObservation(1, io));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
test('#6537 protected unrelated executable retains argv classification and explicit permission fallback evidence', () => {
  for (const exeError of ['EACCES', 'EPERM']) withProcessFiles(['/usr/bin/systemd', '--system'], { exeError }, observe => {
    const record = observe(); assert.equal(record.classification, null); assert.equal(record.executableObserved, false);
    assert.equal(record.executableAccessError, exeError);
    const result = noBuildGraphs({ pids: ['1'], observe }); assert.deepEqual(result.active, []);
    assert.deepEqual(result.permissionFallbacks, [{ pid: 1, executableObserved: false, executableAccessError: exeError }]);
  });
});
test('#6537 protected rustc and Cargo remain blocked and argv-only Cargo can never qualify as an owned verifier', () => {
  for (const tool of ['rustc', 'cargo']) for (const exeError of ['EACCES', 'EPERM']) {
    withProcessFiles(['/tool/' + tool, ...(tool === 'cargo' ? cargoArgs : ['-vV'])], { exeError }, observe => {
      const record = observe(); assert.equal(record.classification.tool, tool);
      assert.throws(() => noBuildGraphs({ pids: ['1'], observe }), /observable Linux build\/test graphs/);
      const candidate = { ...record, startTime: '99', pgrp: 20, cwd: '/arm' };
      assert.equal(freshnessException(candidate, candidate, { group: 20, directory: '/arm', cargo: '/tool/cargo', rustup: '/tool/rustup' }), false);
    });
  }
});
test('#6537 inaccessible cmdline and unexpected exe errors refuse; only disappearing-process races are skipped', () => {
  for (const options of [{ cmdlineError: 'EACCES' }, { cmdlineError: 'EPERM' }, { cmdlineError: 'EIO' }, { exeError: 'EIO' }]) {
    withProcessFiles(['cargo', ...cargoArgs], options, observe => {
      assert.throws(observe, { code: options.cmdlineError ?? options.exeError });
      assert.throws(() => noBuildGraphs({ pids: ['1'], observe }), { code: options.cmdlineError ?? options.exeError });
    });
  }
  for (const code of ['ENOENT', 'ESRCH']) for (const key of ['cmdlineError', 'exeError']) {
    withProcessFiles(['cargo', ...cargoArgs], { [key]: code }, observe => {
      assert.equal(observe(), null); assert.deepEqual(noBuildGraphs({ pids: ['1'], observe }).active, []);
    });
  }
});
test('#6537 actual observed compiler executable controls classification even with unrelated argv0', () => {
  withProcessFiles(['systemd'], { executable: '/tool/rustc' }, observe => {
    const record = observe(); assert.equal(record.executableObserved, true); assert.equal(record.classification.tool, 'rustc');
    assert.throws(() => noBuildGraphs({ pids: ['1'], observe }), /observable Linux build\/test graphs/);
  });
});
