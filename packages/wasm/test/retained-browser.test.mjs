/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7955 H1: the retained browser executor is opt-in. The default engine never
// contains it; importing the `./retained` loader fetches nothing; in the
// separate retained engine, listing sources starts no Worker and only
// constructing an executor reaches /smlib/. Actual-Worker execution is
// covered by scripts/retained-browser-contract.mjs (Chromium + staged SDK).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { it } from 'node:test';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const rootDir = join(packageDir, '..', '..');
const fixture = join(rootDir, 'rust', 'geometry', 'tests', 'fixtures', 'mapped_instances_synthetic.ifc');
const defaultJs = join(packageDir, 'pkg', 'ifc-lite.js');
const retainedJs = join(packageDir, 'pkg-retained', 'ifc-lite.js');
const retainedWasm = join(packageDir, 'pkg-retained', 'ifc-lite_bg.wasm');

function observe() {
  const seen = { workers: [], fetches: [], errors: [] };
  const previous = { Worker: globalThis.Worker, fetch: globalThis.fetch, error: console.error };
  globalThis.Worker = class { constructor(url) { seen.workers.push(String(url)); } };
  globalThis.fetch = async (url) => { seen.fetches.push(String(url)); throw new Error('no network in this test'); };
  console.error = (...args) => seen.errors.push(args.map(String).join(' '));
  seen.restore = () => {
    Object.assign(globalThis, { Worker: previous.Worker, fetch: previous.fetch });
    console.error = previous.error;
  };
  return seen;
}

it('the default engine carries no retained executor or retained API', (t) => {
  if (!existsSync(defaultJs)) { t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh`'); return; }
  const glue = readFileSync(defaultJs, 'utf8');
  for (const name of ['RetainedBrowserExecutor', 'retainedSources', 'retained-driver', '/smlib/']) {
    assert.equal(glue.includes(name), false, `${name} must stay out of the default engine`);
  }
});

it('importing the opt-in loader fetches nothing and starts no Worker', async () => {
  const seen = observe();
  try {
    const { loadRetainedEngine } = await import(pathToFileURL(join(packageDir, 'retained.js')).href);
    assert.equal(typeof loadRetainedEngine, 'function');
    assert.deepEqual([seen.workers, seen.fetches], [[], []]);
  } finally { seen.restore(); }
});

it('retained engine: listing sources is read-only; only the executor reaches /smlib', async (t) => {
  if (!existsSync(retainedJs) || !existsSync(retainedWasm)) {
    t.skip('retained bundle not built — run `BUILD_RETAINED=1 bash scripts/build-wasm.sh`');
    return;
  }
  const seen = observe();
  try {
    const { loadRetainedEngine } = await import(pathToFileURL(join(packageDir, 'retained.js')).href);
    const engine = await loadRetainedEngine({ moduleUrl: pathToFileURL(retainedJs), wasm: readFileSync(retainedWasm) });
    const api = new engine.IfcAPI();
    const sources = api.retainedSources(readFileSync(fixture));
    const listed = sources.sources();
    assert.equal(listed.length, 1, 'one shared mapped extrusion source');
    assert.equal(listed[0].family, 'rectangle');
    assert.ok(listed[0].product_ids.length > 1);
    assert.deepEqual(sources.refused(), []);
    assert.deepEqual([seen.workers, seen.fetches], [[], []], 'listing sources is read-only');
    // Construction is the single boundary: it imports /smlib/client.mjs, which
    // does not exist under Node, so the executor fails closed.
    const executor = new engine.RetainedBrowserExecutor();
    await assert.rejects(executor.capabilities());
    await assert.rejects(sources.execute(0, executor, 0.001, 5, 1 << 20));
    assert.deepEqual(seen.workers, [], 'no transport means no Worker');
    executor.free(); sources.free(); api.free();
  } finally { seen.restore(); }
  assert.ok(seen.errors.every((line) => /retained worker startup/.test(line)), seen.errors.join('\n'));
});

it('the loader imports a deployed bundle once per URL and retries a failed load', async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'retained-loader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(join(dir, 'ifc-lite.js'));
  const { loadRetainedEngine } = await import(pathToFileURL(join(packageDir, 'retained.js')).href);
  // Not deployed yet: the load fails and must not poison later attempts.
  await assert.rejects(loadRetainedEngine({ moduleUrl }));
  writeFileSync(join(dir, 'ifc-lite.js'),
    'export let inits = []; export default async function init(input) { inits.push(input); }\n');
  const first = loadRetainedEngine({ moduleUrl, wasm: 'bytes' });
  assert.equal(loadRetainedEngine({ moduleUrl }), first, 'one load per deployed URL');
  const engine = await first.catch((error) => assert.fail("a failed load stayed cached instead of retrying"));
  assert.deepEqual(engine.inits, [{ module_or_path: 'bytes' }], 'initialized exactly once with the given wasm');
});
