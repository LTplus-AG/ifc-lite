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
