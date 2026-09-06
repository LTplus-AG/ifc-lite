/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';
const { browserStaticPath } = await tsImport('./perf/browser-cold-server-path.ts', import.meta.url);

test('#3978 static root rejects encoded traversal into a sibling with the same prefix', () => {
  const root = resolve('fixture/dist');
  assert.equal(browserStaticPath(root, '/%2e%2e/dist-backup/private.json'), null);
  assert.equal(browserStaticPath(root, '/%zz'), null);
  assert.equal(browserStaticPath(root, '/'), resolve(root, 'index.html'));
  assert.equal(browserStaticPath(root, '/assets/app.js?q=1'), resolve(root, 'assets/app.js'));
});
for (const [flag, value, expected] of [['--port', '65536', /port must be an integer/], ['--iters', '1.5', /iters must/], ['--fault-inject-ms', 'abc', /fault-inject-ms must/], ['--timeout-ms', 'abc', /timeout-ms must/], ['--timeout-ms', '-1', /timeout-ms must/], ['--fault-inject-ms', '-1', /fault-inject-ms must/]]) {
  test(`#3978 rejects ${flag} ${value} before opening a browser/server`, () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/perf/browser-cold-ab.mts', flag, value], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  });
}


test('#3978 shared benchmark setup navigates to the selected server and keeps the CI default', async () => {
  const { ViewerBenchmarkPage } = await tsImport('../tests/benchmark/viewer-benchmark-page.ts', import.meta.url);
  const visits = [];
  const page = {
    on() {}, async addInitScript() {}, async goto(url) { visits.push(url); },
    async waitForSelector() {}, async waitForLoadState() {},
  };
  await new ViewerBenchmarkPage(page, 'http://localhost:3162').setup();
  await new ViewerBenchmarkPage(page).setup();
  assert.deepEqual(visits, ['http://localhost:3162', 'http://localhost:3000']);
});


test('#3978 strict manual loading starts observation without the legacy one-second sleep', async () => {
  const { ViewerBenchmarkPage } = await tsImport('../tests/benchmark/viewer-benchmark-page.ts', import.meta.url);
  const events = [];
  const page = {
    locator() { return { first() { return { async setInputFiles(path) { events.push(path); } }; } }; },
    async waitForTimeout(ms) { events.push(ms); },
  };
  const benchmark = new ViewerBenchmarkPage(page);
  await benchmark.loadFile('manual.ifc', false);
  assert.deepEqual(events, ['manual.ifc']);
  await benchmark.loadFile('ci.ifc');
  assert.deepEqual(events, ['manual.ifc', 'ci.ifc', 1000]);
});

test('#3978 separate nested JSONL/report destinations are writable before browser startup', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { prepareBrowserOutputs } = await tsImport('./perf/browser-cold-outputs.ts', import.meta.url);
  const root = mkdtempSync(resolve(tmpdir(), 'browser-outputs-'));
  try {
    const jsonl = resolve(root, 'new-jsonl/deep/runs.jsonl');
    const report = resolve(root, 'other-report/deep/report.json');
    prepareBrowserOutputs(resolve(root, 'screenshots'), jsonl, report);
    writeFileSync(jsonl, 'retained sample\n');
    writeFileSync(report, '{}');
    assert.equal(readFileSync(jsonl, 'utf8'), 'retained sample\n');
    assert.equal(readFileSync(report, 'utf8'), '{}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#3978 explicit corpus failures and colliding fixture labels reject before browser startup', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(resolve(tmpdir(), 'browser-cohort-'));
  try {
    const a = resolve(root, 'a/same.ifc');
    const b = resolve(root, 'b/same.ifc');
    mkdirSync(resolve(root, 'a')); mkdirSync(resolve(root, 'b'));
    writeFileSync(a, 'fixture'); writeFileSync(b, 'fixture');
    const corpus = resolve(root, 'corpus.json');
    const cases = [
      { entries: [{ name: 'present', path: a }, { name: 'missing', path: resolve(root, 'absent.ifc') }], expected: /Fixture missing/ },
      { entries: [{ name: 'same', path: a }, { name: 'same', path: b }], expected: /Duplicate fixture label/ },
      { entries: [{ name: 'a-b', path: a }, { name: 'a b', path: b }], expected: /Colliding fixture artifact key/ },
    ];
    for (const item of cases) {
      writeFileSync(corpus, JSON.stringify(item.entries));
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/perf/browser-cold-ab.mts', '--dist-branch', root, '--corpus', corpus], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, item.expected);
    }
    const positional = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/perf/browser-cold-ab.mts', '--dist-branch', root, a, b], { encoding: 'utf8' });
    assert.notEqual(positional.status, 0);
    assert.match(positional.stderr, /Duplicate fixture label/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#3978 previous JSONL, report and screenshot evidence is never overwritten', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { prepareBrowserOutputs } = await tsImport('./perf/browser-cold-outputs.ts', import.meta.url);
  const root = mkdtempSync(resolve(tmpdir(), 'browser-retained-'));
  try {
    for (const kind of ['jsonl', 'report', 'screenshot']) {
      const folder = resolve(root, kind); mkdirSync(folder);
      const results = resolve(folder, 'runs'); mkdirSync(results);
      const jsonl = resolve(folder, 'old.jsonl');
      const report = resolve(folder, 'report.json');
      const retained = kind === 'jsonl' ? jsonl : kind === 'report' ? report : resolve(results, 'failed.png');
      writeFileSync(retained, 'retained failure');
      assert.throws(() => prepareBrowserOutputs(results, jsonl, report), /Refusing to overwrite/);
      assert.equal(readFileSync(retained, 'utf8'), 'retained failure');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
