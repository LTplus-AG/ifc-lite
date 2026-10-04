/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { inputWitnessFixture } from './input-witness-fixture.mjs';
import { discoverViewerInput } from './input-witness-discovery.mjs';
import { installViewerInputWitness } from './input-witness-install.mjs';

// Serialization and lifecycle controls, not real React/GPU qualification.
function fixture() {
  const c = vm.createContext({});
  for (const [key, fn] of Object.entries({ fixture: inputWitnessFixture, install: installViewerInputWitness })) {
    c[key] = vm.runInContext(`(${fn.toString()})`, c);
  }
  c.f = c.fixture();
  c.options = { discoverySource: discoverViewerInput.toString(),
    bounds: { deliveries: 100, calls: 100, retainedBytes: 1024 ** 2 },
    referenceAudit: { subjectHead: 'c'.repeat(40), manifestSha256: 'a'.repeat(64), immutableArguments: true } };
  c.go = text => vm.runInContext(text, c);
  c.go('originalQuery = document.querySelector; document.querySelector = () => null;');
  return c;
}

test('#6537 serialized observer retains pending bytes before lazy canvas and native ingestion', () => {
  const c = fixture(), result = c.install(c.options);
  assert.equal(result.awaitsRendererReady, true);
  c.go(`item = f.makeShard([42, 43]); f.notify({ models: new Map([['primary', f.model]]),
    pendingInstancedShards: [{ modelId: 'primary', bytes: item.buffer }] });
    document.querySelector = originalQuery;
    nativeStats = function () { return { frame: 1 }; };
    __ifc_lite_render_stats__ = nativeStats;
    f.scene.addInstancedShard(f.device, item.shard, 0);
    f.notify({ pendingInstancedShards: null }); frozen = __ifc_lite_input_witness__.freeze();`);
  assert.strictEqual(c.frozen.deliveries[0].buffer, c.item.buffer);
  assert.strictEqual(c.frozen.inputs[0].shard, c.item.shard);
  assert.equal(c.frozen.inputs[0].accepted, true);
  assert.equal(c.f.scene.getInstancedEntityCount(), 2);
  const cleanup = c.go('__ifc_lite_input_witness__.dispose()');
  assert.equal(cleanup.restored, true);
  assert.strictEqual(c.go('__ifc_lite_render_stats__'), c.nativeStats);
  assert.equal(c.go('Object.getOwnPropertyDescriptor(globalThis, "__ifc_lite_render_stats__").writable'), true);
  assert.equal(c.go('Object.getOwnPropertyDescriptor(globalThis, "__ifc_lite_render_stats__").enumerable'), true);
  assert.equal(c.f.listeners.size, 0);
});

test('#6537 late/nonempty Scene refuses observation without breaking native hook assignment', () => {
  const c = fixture(); c.install(c.options);
  c.go('f.begin(); document.querySelector = originalQuery; nativeStats = () => 23; __ifc_lite_render_stats__ = nativeStats;');
  assert.equal(c.go('__ifc_lite_render_stats__()'), 23);
  assert.throws(() => c.go('__ifc_lite_input_witness__.freeze()'), /not empty canonical Scene/);
  assert.equal(c.go('__ifc_lite_input_witness__.dispose().restored'), false);
  assert.strictEqual(c.go('__ifc_lite_render_stats__'), c.nativeStats);
});

test('#6537 repeated canonical hook assignment retains latest native value and refuses eligibility', () => {
  const c = fixture(); c.install(c.options);
  c.go('document.querySelector = originalQuery; __ifc_lite_render_stats__ = () => 1; latest = () => 2; __ifc_lite_render_stats__ = latest;');
  assert.throws(() => c.go('__ifc_lite_input_witness__.freeze()'), /repeated\/replaced/);
  c.go('__ifc_lite_input_witness__.dispose()');
  assert.strictEqual(c.go('__ifc_lite_render_stats__'), c.latest);
});

test('#6537 unexpected preexisting accessor refuses before subscriber or native descriptor changes', () => {
  const c = fixture(); c.go('getter = () => 7; Object.defineProperty(globalThis, "__ifc_lite_render_stats__", { configurable: true, get: getter });');
  assert.throws(() => c.install(c.options), /unexpected debug-hook descriptor/);
  assert.equal(c.f.listeners.size, 0);
  assert.strictEqual(c.go('Object.getOwnPropertyDescriptor(globalThis, "__ifc_lite_render_stats__").get'), c.getter);
});

test('#6537 native teardown deletion is retained and cannot qualify an attached snapshot', () => {
  const c = fixture(); c.install(c.options);
  c.go('document.querySelector = originalQuery; __ifc_lite_render_stats__ = () => 1; delete globalThis.__ifc_lite_render_stats__;');
  assert.throws(() => c.go('__ifc_lite_input_witness__.freeze()'), /debug hook deleted\/replaced/);
  assert.equal(c.go('__ifc_lite_input_witness__.dispose().restored'), false);
  assert.equal(c.go('Object.hasOwn(globalThis, "__ifc_lite_render_stats__")'), false);
});

test('#6537 subscribe installation error preserves exact native error and absence of hook', () => {
  const c = fixture(); c.go('nativeError = new Error("subscribe failed"); f.store.subscribe = () => { throw nativeError; };');
  assert.throws(() => c.install(c.options), error => error === c.nativeError);
  assert.equal(c.go('Object.hasOwn(globalThis, "__ifc_lite_render_stats__")'), false);
  assert.equal(c.go('Object.hasOwn(globalThis, "__ifc_lite_input_witness__")'), false);
});
