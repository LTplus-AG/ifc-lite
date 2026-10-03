/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const providerPath = resolve(process.argv[3]);
const requireFromMcp = createRequire(resolve(root, 'packages/mcp/package.json'));
const load = name => import(pathToFileURL(requireFromMcp.resolve(name)).href);
assert.equal(typeof global.gc, 'function', 'Run node --expose-gc --import tsx');
const { IfcParser } = await load('@ifc-lite/parser');
const { MutablePropertyView, StoreEditor } = await load('@ifc-lite/mutations');
const runtime = await load('@ifc-lite/wasm');
const wasm = readFileSync(resolve(root, 'packages/wasm/pkg/ifc-lite_bg.wasm'));
runtime.initSync({ module: wasm });
const { provideHeadlessRoomGeometry } = await import(pathToFileURL(providerPath).href);
const fixture = readFileSync(resolve(root, 'apps/viewer/public/samples/hello-wall.ifc'));
const store = await new IfcParser().parseColumnar(fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength), { disableWorkerScan: true });
const mutationView = new MutablePropertyView(null, 'm');
const model = { modelId: 'm', store, mutationView, editor: new StoreEditor(store, mutationView) };
const references = [];
const parse = IfcParser.prototype.parseColumnar;
// No spy: recorder stores only WeakRefs, never parser results or promises.
IfcParser.prototype.parseColumnar = async function (...args) {
  const parsed = await parse.apply(this, args);
  references.push(new WeakRef(parsed));
  return parsed;
};
const summary = [];
async function selectedPart(factoryOnly) {
  const prepared = await provideHeadlessRoomGeometry(model, 42);
  assert.ok(prepared.walls.length > 0, 'Actual native meshes must supply wall rectangles');
  summary.push({ walls: prepared.walls.length, spaces: prepared.spaces.length });
  return factoryOnly ? prepared.factory : { ...prepared, factory: null };
}
let factoryOnly, withoutFactory;
try {
  factoryOnly = await selectedPart(true);
  withoutFactory = await selectedPart(false);
} finally { IfcParser.prototype.parseColumnar = parse; }
assert.equal(references.length, 2, 'Both provider calls must fresh-parse actual exports');
async function collectEightTurns() {
  for (let turn = 0; turn < 8; turn++) {
    await new Promise(resolveTurn => setImmediate(resolveTurn));
    global.gc();
  }
}
await collectEightTurns();
const factoryRetainsSource = references[0].deref() !== undefined;
const geometryRetainsSource = references[1].deref() !== undefined;
// Exercise the retained factory itself through the real native Rust handle.
const plate = factoryOnly.fromWallRects(new Float64Array(), .01, .1);
plate.free();
factoryOnly = null;
withoutFactory = null;
await collectEightTurns();
const releasedRetainsSource = references.map(reference => reference.deref() !== undefined);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({ node: process.version, providerPath,
  providerSha256: sha256(readFileSync(providerPath)), fixtureSha256: sha256(fixture), wasmSha256: sha256(wasm),
  gcTurnsPerPhase: 8, native: summary, factoryRetainsSource, geometryRetainsSource, releasedRetainsSource }, null, 2));
assert.equal(geometryRetainsSource, false, 'Primitive prepared geometry must not retain the reparsed source');
assert.deepEqual(releasedRetainsSource, [false, false], 'Released-result GC control must collect both sources');
assert.equal(factoryRetainsSource, false, '#6232 retained native Room factory must not retain the reparsed IFC source');
