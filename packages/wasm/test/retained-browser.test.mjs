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
const defaultWasm = join(packageDir, 'pkg', 'ifc-lite_bg.wasm');
const retainedJs = join(packageDir, 'pkg-retained', 'ifc-lite.js');
const retainedWasm = join(packageDir, 'pkg-retained', 'ifc-lite_bg.wasm');

it('#7955 M11-I actual IFNS encoder verifies rotated RTC pairs and returns rejected groups flat', async (t) => {
  if (!existsSync(retainedWasm)) { t.skip('retained WASM not built; not boundary evidence'); return; }
  const wasm = await import(pathToFileURL(retainedJs).href);
  wasm.initSync(readFileSync(retainedWasm));
  // Hand-derived XY triangle at a surveyed origin, alternating 90-degree rotations.
  const input = Array.from({ length: 64 }, (_, i) => {
    const c = i % 2 ? 0 : 1, s = i % 2 ? 1 : 0;
    return { expressId: i + 1, ifcType: 'IfcBeam', color: [1, 0, 0, 1],
      positions: Float32Array.of(0,0,0, c,0,-s, -s,0,-c), normals: Float32Array.of(0,1,0, 0,1,0, 0,1,0),
      indices: Uint32Array.of(0,1,2), origin: [i*3,0,0],
      worldFromObject: Float64Array.of(c,s,0,0, -s,c,0,0, 0,0,1,0, 2600000+i*3,1200000,0,1) };
  });
  const encode = values => wasm.encodeInstancedShard(values, values.map(() => '1'.repeat(64)), Float64Array.of(2600000,1200000,0));
  const result = encode(input);
  assert.equal(result.groupCount, 1);
  assert.equal(result.instanceCount, 64);
  assert.equal(result.verificationRejections, 0);
  assert.equal(result.flatIndices.length, 0);
  const header = new DataView(result.shard.buffer);
  assert.equal(header.getUint32(24, true) * header.getUint32(12, true), 3 * 64, 'flat and rendered triangle counts match');
  assertRenderedCoordinates(result.shard, input);
  const small = encode(input.slice(0, 7));
  assert.equal(small.shard.length, 0);
  assert.equal(small.flatIndices.length, 7);
  const corrupt = input.slice(0, 8).map(m => ({ ...m, positions: m.positions.slice() }));
  corrupt[3].positions[3] += 0.1;
  const rejected = encode(corrupt);
  assert.equal(rejected.verificationRejections, 1, '#3666 sees mismatched actual geometry');
  assert.equal(rejected.shard.length, 0);
  assert.equal(rejected.flatIndices.length, 8, 'all failed group members render flat');
  for (const changes of [{ color: [1,0,0,0.5] }, { geometryClass: 1 }, { texture: {} }, { ifcType: 'IfcSpace' }]) {
    const values = input.slice(0, 8).map(m => ({ ...m, ...changes }));
    assert.equal(encode(values).flatIndices.length, 8, 'exact eligibility gates apply');
  }
});

/** IFNS is native Z-up; independently apply its wire matrix and renderer axis swap. */
function assertRenderedCoordinates(shard, input) {
  const view = new DataView(shard.buffer, shard.byteOffset, shard.byteLength);
  const templates = view.getUint32(8, true), instances = view.getUint32(12, true);
  const stride = view.getUint32(28, true) || 88;
  const table = 32 + templates * 48, positions = table + instances * stride;
  const normals = positions + view.getUint32(16, true) * 4;
  for (let i = 0; i < instances; i++) {
    const record = table + i * stride, template = 32 + view.getUint32(record, true) * 48;
    const source = input.find(m => m.expressId === view.getUint32(record + 4, true));
    const origin = [0, 1, 2].map(axis => view.getFloat64(template + 24 + axis * 8, true));
    const start = view.getUint32(template, true), count = view.getUint32(template + 4, true);
    const matrix = Array.from({ length: 16 }, (_, j) => view.getFloat32(record + 24 + j * 4, true));
    for (let v = 0; v < count; v += 3) {
      const point = [0, 1, 2].map(axis => origin[axis] + view.getFloat32(positions + (start + v + axis) * 4, true));
      const world = [0, 1, 2].map(row => matrix[row * 4] * point[0] + matrix[row * 4 + 1] * point[1]
        + matrix[row * 4 + 2] * point[2] + matrix[row * 4 + 3]);
      const rendered = [world[0], world[2], -world[1]];
      for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(rendered[axis]
        - (source.origin[axis] + source.positions[v + axis])) <= 1e-6, 'IFNS and flat render at the same coordinates');
    }
  }
  // All hand-authored normals point along IFC +Z, even after a Z-axis rotation.
  for (let n = 0; n < view.getUint32(20, true); n += 3) {
    assert.deepEqual([0, 1, 2].map(axis => view.getFloat32(normals + (n + axis) * 4, true) + 0), [0, 0, 1]);
  }
}

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

it('the default engine carries no retained executor or retained API', async (t) => {
  if (!existsSync(defaultJs)) { t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh`'); return; }
  const seen = observe();
  try {
    // Behaviour, not text: load the actual default engine and probe its API.
    const engine = await import(pathToFileURL(defaultJs).href);
    engine.initSync(readFileSync(defaultWasm));
    assert.equal('RetainedBrowserExecutor' in engine, false, 'no retained executor export');
    assert.equal('encodeInstancedShard' in engine, false, 'no retained instancing export');
    const api = new engine.IfcAPI();
    assert.equal(typeof api.retainedSources, 'undefined', 'no retainedSources on the default IfcAPI');
    api.free();
    assert.deepEqual([seen.workers, seen.fetches], [[], []], 'loading the default engine reaches no /smlib Worker');
  } finally { seen.restore(); }
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
  // Fail-closed is proven by the rejects above; this pins that nothing else
  // is logged. The startup-failure line itself is asynchronous, so its
  // presence is not asserted (requiring it would race the test's end).
  const unexpected = seen.errors.filter((line) => !/retained worker startup/.test(line));
  assert.deepEqual(unexpected, [], 'no error beyond the expected startup failure');
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
