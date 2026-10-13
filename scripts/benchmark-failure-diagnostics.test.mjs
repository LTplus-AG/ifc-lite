/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';

const { withBenchmarkFailureDiagnostics } = await tsImport('../tests/benchmark/benchmark-failure-diagnostics.ts', import.meta.url);

const rawTrace = { start: 10, end: 30, spans: [{ name: 'scene.finalize', start: 20, end: null }] };
const page = {
  async refreshLoadTrace() {},
  getLoadTrace: () => rawTrace,
  getConsoleLogs: () => ['geometry complete', 'renderer pending'],
};

function fixture(t) {
  const outputDir = mkdtempSync(join(tmpdir(), 'benchmark-failure-'));
  t.after(() => rmSync(outputDir, { recursive: true, force: true }));
  return { outputDir, captureTimeoutMs: 20 };
}

test('#7005 failed readiness retains raw trace and console but cannot become a benchmark sample', async t => {
  const options = fixture(t);
  const original = new Error('readiness incomplete');
  await assert.rejects(withBenchmarkFailureDiagnostics(page, 'Snowdon.ifc', async () => { throw original; }, options), error => error === original);
  const files = readdirSync(options.outputDir);
  assert.equal(files.length, 2);
  const jsonName = files.find(name => name.endsWith('.json'));
  assert.ok(jsonName.startsWith('failure-Snowdon_ifc-'));
  const receipt = JSON.parse(readFileSync(join(options.outputDir, jsonName), 'utf8'));
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error.message, original.message);
  assert.deepEqual(receipt.trace, rawTrace);
  assert.deepEqual(receipt.collectionErrors, []);
  assert.equal(readFileSync(join(options.outputDir, jsonName.replace(/\.json$/, '.console.log')), 'utf8'), 'geometry complete\nrenderer pending');
});

for (const mode of ['rejected', 'unresponsive']) {
  test(`#7005 ${mode} diagnostic page cannot hide the original readiness failure`, async t => {
    const options = fixture(t);
    const original = new Error('original timeout');
    const failedPage = { ...page, refreshLoadTrace: () => mode === 'rejected'
      ? Promise.reject(new Error('page closed')) : new Promise(() => {}) };
    await assert.rejects(withBenchmarkFailureDiagnostics(failedPage, 'model.ifc', async () => { throw original; }, options), error => error === original);
    const jsonName = readdirSync(options.outputDir).find(name => name.endsWith('.json'));
    const receipt = JSON.parse(readFileSync(join(options.outputDir, jsonName), 'utf8'));
    assert.equal(receipt.trace, null, 'never present a stale cached trace as freshly captured');
    assert.equal(receipt.collectionErrors.length, 1);
    assert.equal(receipt.collectionErrors[0].message, mode === 'rejected' ? 'page closed' : 'Failure trace capture timed out');
    assert.equal(receipt.error.message, original.message);
  });
}

test('#7005 artifact write failure preserves the original error', async t => {
  const options = fixture(t);
  const blocked = join(options.outputDir, 'not-a-directory');
  writeFileSync(blocked, 'owned test file');
  const original = new Error('original readiness error');
  await assert.rejects(withBenchmarkFailureDiagnostics(page, 'model.ifc', async () => { throw original; },
    { ...options, outputDir: blocked }), error => error === original);
});

test('#7005 successful readiness creates no failure artifacts or additional browser reads', async t => {
  const options = fixture(t);
  const unexpectedRead = () => { throw new Error('success must not collect failure diagnostics'); };
  assert.equal(await withBenchmarkFailureDiagnostics({ ...page, refreshLoadTrace: unexpectedRead }, 'model.ifc', async () => 42, options), 42);
  assert.deepEqual(readdirSync(options.outputDir), []);
});


test('#7005 colliding readable names and repeated failures preserve every attempt', async t => {
  const options = fixture(t);
  const names = ['A-B.ifc', 'A_B.ifc', 'A-B.ifc'];
  for (const [index, name] of names.entries()) {
    const error = new Error(`attempt ${index}`);
    await assert.rejects(withBenchmarkFailureDiagnostics(page, name, async () => { throw error; }, options), value => value === error);
  }
  const files = readdirSync(options.outputDir);
  assert.equal(files.length, 6);
  const jsonNames = files.filter(name => name.endsWith('.json'));
  assert.equal(jsonNames.length, 3);
  const receipts = jsonNames.map(name => JSON.parse(readFileSync(join(options.outputDir, name), 'utf8')));
  assert.deepEqual(receipts.map(receipt => receipt.file).sort(), [...names].sort());
  assert.deepEqual(receipts.map(receipt => receipt.error.message).sort(), ['attempt 0', 'attempt 1', 'attempt 2']);
  for (const name of jsonNames) {
    assert.equal(readFileSync(join(options.outputDir, name.replace(/\.json$/, '.console.log')), 'utf8'), 'geometry complete\nrenderer pending');
  }
});
