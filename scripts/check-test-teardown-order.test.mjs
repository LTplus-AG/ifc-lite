/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the test teardown order gate. Everything runs against synthetic
 * sources in memory, never against the repo, so a change to a test file cannot
 * make these vacuously green.
 *
 * Run: `node --test scripts/check-test-teardown-order.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, scanSource } from './check-test-teardown-order.mjs';

const rules = (src, path = 'x.test.ts') => scanSource(path, src).violations.map((v) => `${v.rule}:${v.line}`);

// apps/viewer/src/lib/retained/retained-engine.test.ts before #8494, trimmed:
// the shape that failed viewer shard 12 in eight merge-queue runs.
const RETAINED_ENGINE_BEFORE = `import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
async function fixture(t: TestContext) {
  const root = await mkdtemp('viewer-engine-');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root };
}
for (const mode of ['dev', 'preview'] as const) {
  test(mode, async (t) => {
    const f = await fixture(t);
    const server = await createServer({ root: f.root });
    t.after(() => server.close());
  });
}
`;

// The same file as #8494 fixed it: servers close inside the removing hook.
const RETAINED_ENGINE_AFTER = `import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
async function fixture(t: TestContext) {
  const root = await mkdtemp('viewer-engine-');
  const closers: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const close of closers) await close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, closers };
}
test('dev', async (t) => {
  const f = await fixture(t);
  const server = await createServer({ root: f.root });
  f.closers.push(() => server.close());
});
`;

test('flags the retained-engine fixture that failed shard 12 (R2), and passes its fix', () => {
  assert.deepEqual(rules(RETAINED_ENGINE_BEFORE), ['R2:5']);
  assert.deepEqual(rules(RETAINED_ENGINE_AFTER), []);
});

test('R1: a removing t.after followed by another t.after in the same function', () => {
  const src = `import test from 'node:test';
import { rm } from 'node:fs/promises';
test('x', async t => {
  const root = await mkdtemp('smlib-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const transport = new Transport(root);
  t.after(() => transport.dispose());
});`;
  assert.deepEqual(rules(src, 'x.test.mjs'), ['R1:5']);
});

test('R1 covers rmSync, rmdir and module-level after/afterEach', () => {
  const src = `import { after, afterEach, describe } from 'node:test';
import fs from 'node:fs';
describe('d', () => {
  after(() => fs.rmSync(dir, { recursive: true }));
  after(() => server.close());
  afterEach(() => fs.rmdirSync(a));
  afterEach(() => child.kill());
});`;
  assert.deepEqual(rules(src, 'x.test.mjs'), ['R1:4', 'R1:6']);
});

test('passes removal registered last, or released first inside one hook', () => {
  const last = `import test from 'node:test';
test('x', async t => {
  const server = start();
  t.after(() => server.close());
  t.after(() => rm(root, { recursive: true }));
});`;
  const one = `import test from 'node:test';
test('x', async t => {
  let driver;
  t.after(async () => { try { await driver?.retire(); } finally { await rm(root, { recursive: true }); } });
  driver = new Driver();
});`;
  assert.deepEqual(rules(last), []);
  assert.deepEqual(rules(one), []);
});

test('different receivers and different tests are independent', () => {
  const src = `import test from 'node:test';
test('a', async t => { t.after(() => rm(a)); });
test('b', async t => { t.after(() => server.close()); });
test('c', async (t) => { t.after(() => rm(a)); s.after(() => x()); });`;
  assert.deepEqual(rules(src), []);
});

test('R2 needs a caller that registers after the helper', () => {
  const src = `import test from 'node:test';
async function tmp(t) { const d = await mkdtemp('x'); t.after(() => rm(d, { recursive: true })); return d; }
test('only the helper', async t => { const d = await tmp(t); await write(d); });
test('hook before helper', async t => { t.after(() => close()); const d = await tmp(t); });`;
  assert.deepEqual(rules(src), []);
});

test('vitest hooks run in reverse and are not judged by R1/R2', () => {
  const src = `import { afterEach, it } from 'vitest';
it('x', () => {});
afterEach(() => rm(dir, { recursive: true }));
afterEach(() => server.close());`;
  assert.deepEqual(rules(src), []);
});

test('R3: a removal pushed before another disposer and drained front to back', () => {
  // packages/mcp/src/tools/bcf-publication-native.test.ts before this gate.
  const helper = `import { afterEach, it } from 'vitest';
const cleanup = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function fixture() {
  const directory = await mkdtemp('x');
  const peer = await start();
  cleanup.push(peer.close, () => rm(directory, { recursive: true, force: true }));
  return { directory, peer };
}
it('x', async () => {
  const { directory } = await fixture();
  const hostile = createServer();
  cleanup.push(() => hostile.close());
});`;
  assert.deepEqual(rules(helper), ['R3:7']);
  const samePush = `const cleanup = [];
afterEach(async () => { for (const d of cleanup) await d(); });
it('x', () => { cleanup.push(() => rm(dir), () => server.close()); });`;
  assert.deepEqual(rules(samePush, 'x.test.js'), ['R3:3']);
  const sameFn = `const cleanup = [];
afterEach(async () => { for (const d of cleanup.splice(0)) await d(); });
it('x', () => { cleanup.push(() => rmSync(dir)); cleanup.push(() => child.kill()); });`;
  assert.deepEqual(rules(sameFn, 'x.test.js'), ['R3:3']);
});

test('R3 passes a reversed drain, a removal pushed last, and lists without removals', () => {
  const reversed = `const cleanup = [];
afterEach(async () => { for (const d of cleanup.splice(0).reverse()) await d(); });
it('x', () => { cleanup.push(() => rm(dir)); cleanup.push(() => server.close()); });`;
  const last = `const cleanup = [];
afterEach(async () => { for (const d of cleanup.splice(0)) await d(); });
it('x', () => { cleanup.push(() => server.close(), () => rm(dir)); });`;
  const plain = `const stops = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
it('x', () => { stops.push(a); stops.push(b); });`;
  for (const src of [reversed, last, plain]) assert.deepEqual(rules(src, 'x.test.js'), [], src);
});

test('counts removals so a broken detector cannot report a clean tree', () => {
  assert.equal(scanSource('x.test.ts', RETAINED_ENGINE_AFTER).removals, 1);
  const files = ['a.test.ts'];
  const read = () => RETAINED_ENGINE_AFTER;
  const small = runCheck('.', { files, read });
  assert.ok(small.errors.some((e) => /suspiciously small/.test(e)), small.errors.join('\n'));
  assert.ok(small.errors.some((e) => /teardown removals/.test(e)), small.errors.join('\n'));
  const ok = runCheck('.', { files, read, fileFloor: 1, removalFloor: 1 });
  assert.deepEqual(ok.errors, []);
  const bad = runCheck('.', { files, read: () => RETAINED_ENGINE_BEFORE, fileFloor: 1, removalFloor: 1 });
  assert.deepEqual(bad.violations.map((v) => `${v.path}:${v.line}:${v.rule}`), ['a.test.ts:5:R2']);
});
