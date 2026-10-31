/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeSample, main as nativeMain } from './retained-qual-native-memory.mjs';
import { assertNativeSummary } from './retained-qual-assert.mjs';
import { roundSides, resultEnvelope } from './retained-qual-lib.mjs';
import { compare, format, readRows } from './retained-qual-report.mjs';
import { startSampler } from './retained-qual-proc.mjs';

// PR #8413: each witness exercises the runner's public behaviour.
const summary = { schema: 'ifc-lite.native-retained-comparison/1', complete: true, violations: [], retained: {}, candidates: 4, published: 3 };
test('8413: incomplete native corpus cannot pass', () => {
  assertNativeSummary({ exitCode: 0, summary: { ...summary, skipped: [], universeMismatch: [] } });
  for (const patch of [{ skipped: ['missing.ifc'] }, { universeMismatch: true }, { universeMismatch: ['unexpected.ifc'] }])
    assert.throws(() => assertNativeSummary({ exitCode: 0, summary: { ...summary, ...patch } }), /skipped|universeMismatch/);
});
test('8413: an existing summary is refused before launching another invocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qual-stale-'));
  try {
    const path = join(dir, 'summary.json'); writeFileSync(path, JSON.stringify(summary));
    await assert.rejects(nativeSample({ command: ['/bin/true'], summaryPath: path, workerName: 'none' }), /summary.*exist|fresh|unique/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('8413: invalid native side is rejected before touching output', async () => {
  await assert.rejects(nativeMain(['--out', '/does/not/exist/no-output', '--summary', '/unused', '--side', 'oops', '--', '/bin/true']), /--side/);
});
test('8413: seeds must be finite even for a single arm', async () => {
  for (const seed of [NaN, Infinity, -Infinity]) await assert.rejects(roundSides([{ side: 'branch' }], 1, seed), /finite/);
});
test('8413: envelope identity follows branch with reversed arm order', () => {
  const identities = ['branch', 'base'].map(commit => ({ git: { commit }, engine: { manifestSha256: commit } }));
  const result = resultEnvelope({ kind: 'test', options: {}, arms: [{ side: 'branch' }, { side: 'base' }], identities, fixtures: [], started: 0 });
  assert.equal(result.commit, 'branch'); assert.equal(result.engineManifestSha256, 'branch');
});
const row = (side, round, extra = {}) => ({ side, round, path: '/m/a.ifc', kind: 'viewer', ok: true, totalMs: 10, ...extra });
test('8413: distinct runner kinds never pair', () => {
  const report = compare([row('base', 1), row('branch', 1, { kind: 'browser-memory' })]);
  assert.equal(report.fixtures.length, 2); assert.equal(report.flags.unpaired, true);
});
test('8413: disjoint rounds and unequal nullable coverage are incomplete', () => {
  assert.equal(compare([row('base', 1), row('branch', 2)]).flags.unpaired, true);
  const report = compare([row('base', 1, { settledFrameMs: 8 }), row('base', 2, { settledFrameMs: null }), row('branch', 1, { settledFrameMs: 9 }), row('branch', 2, { settledFrameMs: 99 })]);
  const col = report.fixtures[0].columns.find(c => c.column === 'settledFrameMs');
  assert.deepEqual([col.baseN, col.branchN, col.pairedN], [1, 2, 1]);
  assert.equal(col.branchMedian, 9); assert.equal(report.flags.incompleteCoverage, true);
});
test('8413: report retains host, commit, and non-exclusive provenance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qual-report-'));
  try {
    writeFileSync(join(dir, 'runs.jsonl'), [row('base', 1), row('branch', 1)].map(r => JSON.stringify(r)).join('\n'));
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ kind: 'viewer', host: { hostname: 'test-host' }, commit: 'test-sha', exclusivity: { exclusive: false, note: 'non-exclusive observation' }, startedAt: 'run1' }));
    const report = compare(readRows([dir]));
    assert.match(JSON.stringify(report), /test-host/); assert.match(format(report), /non-exclusive/); assert.match(format(report), /test-sha/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('8413: all failed PSS reads stay unavailable and disclose coverage', () => {
  const result = startSampler(process.pid, { pss: true, readInfo: pid => ({ pid, rssKiB: 1, hwmKiB: 1, pssKiB: null }) }).stop();
  assert.equal(result.maxObservedConcurrentPssKiB, null);
  assert.equal(result.pssCoverage.reads, 0); assert.ok(result.pssCoverage.attempts > 0);
});

test('8413: viewer launch failure becomes a failed row', async () => {
  const { viewerSample } = await import('./retained-qual-viewer.mjs');
  const row = await viewerSample({ arm: { side: 'branch' }, fixture: { path: '/m/a.ifc' }, round: 1, options: {}, distTree: {},
    launcher: async () => { throw new Error('invalid executable'); } });
  assert.equal(row.ok, false); assert.match(row.error, /invalid executable/);
});
test('8413: native provenance never invents a worker binary without --worker', async () => {
  const { readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'qual-native-'));
  try {
    assert.equal(await nativeMain(['--out', dir, '--summary', join(dir, 'summary.json'), '--', '/bin/true']), 1);
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    assert.ok(result.binaries.executable); assert.equal(result.binaries.worker, undefined);
    assert.equal(result.exclusivity.exclusive, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('8413: all multi-arm CLIs reject non-finite seeds before preparation', async () => {
  for (const file of ['cli', 'viewer', 'browser-memory']) {
    const { main } = await import(`./retained-qual-${file}.mjs`);
    for (const seed of ['abc', 'Infinity']) await assert.rejects(main(['--out', '/unused', '--seed', seed]), /finite/);
  }
});
test('8413: viewer store errors and missing terminal frames end the wait promptly', async () => {
  const { viewerSample } = await import('./retained-qual-viewer.mjs');
  const vm = await import('node:vm');
  let checked = false;
  const page = { addInitScript: async () => {}, goto: async () => {}, locator: () => ({ waitFor: async () => {}, setInputFiles: async () => {} }),
    waitForFunction: async (fn, key) => {
      if (!key) return;
      for (const [error, now, first, expected] of [['load failed', 1, null, true], [null, 31001, null, true], [null, 101, null, false], [null, 5001, 20, true]]) {
        const context = { [key]: { errors: [], terminalMs: 0, firstRetainedFrameMs: first, settledFrameMs: null },
          __ifc_lite_viewer_store__: { getState: () => ({ error }) }, performance: { now: () => now } };
        assert.equal(vm.runInNewContext(`(${fn.toString()})(${JSON.stringify(key)})`, context), expected);
      }
      checked = true; throw new Error('predicate checked');
    } };
  await viewerSample({ arm: { side: 'branch' }, preview: { origin: 'http://test' }, fixture: { path: '/a.ifc' }, round: 1, options: {}, distTree: {},
    launcher: async () => ({ page, profileDir: '/not-a-browser-profile', pageErrors: [], consoleLines: [], close: async () => null }) });
  assert.equal(checked, true);
});

test('8413: an unrelated writer cannot supply the measured child summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qual-owner-'));
  try {
    const path = join(dir, 'summary.json');
    const writer = setTimeout(() => writeFileSync(path, JSON.stringify(summary)), 20);
    const row = await nativeSample({ command: [process.execPath, '-e', 'setTimeout(() => {}, 180)', '--', '--out', dir],
      summaryPath: path, workerName: 'node', intervalMs: 5 });
    clearTimeout(writer);
    assert.equal(row.ok, false);
    assert.match(row.error, /summary|child|output/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('8413: the child writes its own summary to the unique --out directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qual-child-'));
  try {
    const source = `const fs = require('node:fs'); const out = process.argv[2];
      fs.mkdirSync(out, {recursive:true}); fs.writeFileSync(out + '/summary.json', ${JSON.stringify(JSON.stringify(summary))});
      setTimeout(() => {}, 180);`;
    const row = await nativeSample({ command: [process.execPath, '-e', source, '--', '--out', dir],
      summaryPath: join(dir, 'summary.json'), workerName: 'node', intervalMs: 5 });
    assert.equal(row.ok, true, row.error);
    assert.notEqual(row.childOutput, dir);
    assert.equal(row.measuredCommand.at(-1), row.childOutput);
    assert.equal(row.published, summary.published);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// #8413: preview failure artifacts are inputs to the real report reader.
test('8413: a preview startup failure preserves every arm and fixture identity for reporting', async () => {
  const { runViewerCohort } = await import('./retained-qual-viewer.mjs');
  const { writeResult } = await import('./retained-qual-lib.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'qual-preview-report-'));
  try {
    const arms = [{ side: 'base' }, { side: 'branch' }];
    const fixtures = [{ path: '/a/model.ifc' }, { path: '/b/model.ifc' }];
    const { rows } = await runViewerCohort({ arms, fixtures, rounds: 2, options: {}, expectations: {}, out: dir,
      start: async () => { throw new Error('vite preview port already occupied'); } });
    writeResult(dir, { kind: 'viewer-first-retained-frame' }, rows);
    const report = compare(readRows([dir]));
    assert.equal(report.failures.length, 4);
    for (const arm of arms) for (const fixture of fixtures) {
      const failure = report.failures.find(row => row.side === arm.side && row.path === fixture.path);
      assert.match(failure?.error ?? '', /port already occupied/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const runner of ['viewer', 'cli', 'browser-memory']) {
  test(`8413: ${runner} rejects incomplete --expect pins before preparing any arm`, async () => {
    const { main } = await import(`./retained-qual-${runner}.mjs`);
    const dir = mkdtempSync(join(tmpdir(), 'qual-pin-coverage-'));
    const pin = { candidates: 4, published: 3 };
    try {
      const fixture = '/a/model.ifc', pinsPath = join(dir, 'pins.json');
      for (const pins of [{ '/other/model.ifc': pin }, { 'model.ifc': pin }, { base: { [fixture]: pin } }, { [fixture]: null }]) {
        writeFileSync(pinsPath, JSON.stringify(pins));
        await assert.rejects(main(['--out', join(dir, 'out'), '--expect', pinsPath,
          '--arm', 'branch:/unprepared-checkout:/unprepared-engine', '--fixture', fixture]),
        error => /--expect/.test(error.message) && /branch/.test(error.message) && error.message.includes(fixture));
      }
      // A matching first fixture must not hide an unpinned later fixture.
      writeFileSync(pinsPath, JSON.stringify({ [fixture]: pin }));
      await assert.rejects(main(['--out', join(dir, 'out'), '--expect', pinsPath,
        '--arm', 'branch:/unprepared-checkout:/unprepared-engine', '--fixture', fixture, '--fixture', '/b/model.ifc']),
      error => /--expect/.test(error.message) && /branch/.test(error.message) && error.message.includes('/b/model.ifc'));
      // A complete pin file passes preflight and reaches engine preparation.
      await assert.rejects(main(['--out', join(dir, 'out'), '--expect', pinsPath,
        '--arm', 'branch:/unprepared-checkout:/unprepared-engine', '--fixture', fixture]),
      error => !/--expect/.test(error.message));
      // Even if the first arm has a pin, startup must inspect the second arm.
      writeFileSync(pinsPath, JSON.stringify({ base: { [fixture]: pin } }));
      await assert.rejects(main(['--out', join(dir, 'out'), '--expect', pinsPath,
        '--arm', 'base:/unprepared-checkout:/unprepared-engine', '--arm', 'branch:/unprepared-checkout:/unprepared-engine', '--fixture', fixture]),
      error => /--expect/.test(error.message) && /branch/.test(error.message) && error.message.includes(fixture));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
