/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { inputWitnessFixture } from './input-witness-fixture.mjs';
import { discoverViewerInput } from './input-witness-discovery.mjs';
import { installViewerInputWitness } from './input-witness-install.mjs';
import { captureViewerInputIdentity } from './input-witness-capture.mjs';
import { requireViewerInputIdentityPair } from './input-witness-policy.mjs';
import { captureIdentity } from './interleaved-identity.mjs';
import { expectedZeroPlacedMesh } from './input-witness-zero-placement.mjs';

// These controls qualify collector behavior, not production Scene/GPU behavior.
// Each browser callback actually executes its serialized function in a VM with
// no module closures, __name helper, or Node globals. Fixtures interpret buffers.
function fixture(options = {}) {
  const context = vm.createContext({ TextEncoder, crypto: webcrypto });
  for (const [key, fn] of Object.entries({ fixture: inputWitnessFixture, discovery: discoverViewerInput,
    install: installViewerInputWitness, capture: captureViewerInputIdentity, legacy: captureIdentity })) {
    context[key] = vm.runInContext(`(${fn.toString()})`, context);
  }
  context.f = context.fixture();
  context.options = { discoverySource: discoverViewerInput.toString(),
    bounds: { deliveries: 100, calls: 100, retainedBytes: 1024 ** 2, ...options },
    referenceAudit: { subjectHead: 'c'.repeat(40), manifestSha256: 'a'.repeat(64), immutableArguments: true } };
  context.limits = { oneBufferBytes: 1024 ** 2, digestBytes: 16 * 1024 ** 2, records: 100000,
    zeroPlacementSource: expectedZeroPlacedMesh.toString() };
  context.go = source => vm.runInContext(source, context);
  return context;
}
async function completed(setup = '', owners = [[42]]) {
  const c = fixture(); c.install(c.options); c.f.begin(); c.go(setup);
  for (const ids of owners) c.f.deliver(c.f.makeShard(ids));
  const row = await c.capture(c.limits);
  return { c, row };
}

test('#6537 serialized callbacks observe transient delivery and preserve native return/receiver', async () => {
  const c = fixture(); c.install(c.options); c.f.begin();
  c.go('f.scene.nativeReturn = { opaque: 17 };');
  const item = c.f.makeShard([42, 43]), returned = c.f.deliver(item);
  assert.strictEqual(returned, c.f.scene.nativeReturn);
  assert.strictEqual(c.f.nativeCalls[0].receiver, c.f.scene);
  assert.strictEqual(c.f.nativeCalls[0].args[1], item.shard);
  assert.equal(c.f.store.getState().pendingInstancedShards, null);
  const row = await c.capture(c.limits);
  assert.equal(row.instanceOwners, 2); assert.equal(row.occurrences, 2);
  assert.equal(row.rawInstancedInputs.length, 1);
  assert.equal(c.go('typeof __name'), 'undefined');
});
test('#6537 native throw is identical and accepted-input evidence refuses', () => {
  const c = fixture(); c.install(c.options); c.f.begin(); c.go('f.scene.nativeError = new Error("native failure");');
  assert.throws(() => c.f.deliver(c.f.makeShard()), error => error === c.f.scene.nativeError);
  assert.throws(() => c.go('__ifc_lite_input_witness__.freeze()'), /native instance ingestion threw/);
});
test('#6537 unexpected receiver is still delegated unchanged and cannot qualify', () => {
  const c = fixture(); c.install(c.options); c.f.begin(); const item = c.f.makeShard();
  c.item = item; c.go('f.notify({ pendingInstancedShards: [{ modelId: "primary", bytes: item.buffer }] }); foreign = { ...f.scene, nativeReturn: { foreign: true } };');
  assert.strictEqual(c.f.scene.addInstancedShard.call(c.foreign, c.f.device, item.shard, 0), c.foreign.nativeReturn);
  assert.strictEqual(c.f.nativeCalls[0].receiver, c.foreign);
  assert.throws(() => c.go('__ifc_lite_input_witness__.freeze()'), /ownership\/shape/);
});
test('#6537 failed installation rolls back exact native descriptors and no global witness', () => {
  const c = fixture(), original = Object.getOwnPropertyDescriptors(c.f.scene);
  c.go('failure = new Error("subscribe failure"); f.store.subscribe = () => { throw failure; };');
  assert.throws(() => c.install(c.options), error => error === c.failure);
  assert.deepEqual(Object.getOwnPropertyDescriptors(c.f.scene), original);
  assert.equal(c.__ifc_lite_input_witness__, undefined);
});
test('#6537 inherited method cleanup restores absence of own descriptor and subscription', () => {
  const c = fixture(); c.go('native = f.scene.addInstancedShard; delete f.scene.addInstancedShard; Object.setPrototypeOf(f.scene, { addInstancedShard: native });');
  c.install(c.options); assert.equal(c.f.listeners.size, 1);
  assert.equal(Object.hasOwn(c.f.scene, 'addInstancedShard'), true);
  assert.equal(c.go('__ifc_lite_input_witness__.dispose().restored'), true);
  assert.equal(Object.hasOwn(c.f.scene, 'addInstancedShard'), false);
  assert.strictEqual(c.f.scene.addInstancedShard, c.native); assert.equal(c.f.listeners.size, 0);
});
test('#6537 missed or repeated delivery refuses rather than scene-derived eligibility', () => {
  const a = fixture(); a.install(a.options); a.f.begin();
  a.f.scene.addInstancedShard(a.f.device, a.f.makeShard().shard, 0);
  assert.throws(() => a.go('__ifc_lite_input_witness__.freeze()'), /not linked/);
  const b = fixture(); b.install(b.options); b.f.begin(); const item = b.f.makeShard(); b.f.deliver(item); b.f.deliver(item);
  assert.throws(() => b.go('__ifc_lite_input_witness__.freeze()'), /delivered again/);
});
test('#6537 native mutation and late delivery refuse while original native path continues', () => {
  const c = fixture(); c.install(c.options); c.f.begin(); c.f.deliver(c.f.makeShard());
  assert.equal(c.f.scene.removeMeshesForEntity(42), true);
  assert.throws(() => c.go('__ifc_lite_input_witness__.freeze()'), /unsupported canonical mutation/);
  const d = fixture(); d.install(d.options); d.f.begin(); d.f.deliver(d.f.makeShard()); d.go('__ifc_lite_input_witness__.freeze()');
  d.f.deliver(d.f.makeShard([43])); assert.equal(d.f.nativeCalls.length, 2);
  assert.throws(() => d.go('__ifc_lite_input_witness__.validate(0)'), /after freeze|late/);
});
test('#6537 source-retention cap refuses without suppressing native ingestion', () => {
  const c = fixture({ retainedBytes: 100 }); c.install(c.options); c.f.begin(); c.f.deliver(c.f.makeShard());
  assert.equal(c.f.nativeCalls.length, 1);
  assert.throws(() => c.go('__ifc_lite_input_witness__.freeze()'), /retained input cap/);
});
test('#6537 hidden produced channels remain hashed independently of filtered viewport', async () => {
  const setup = 'f.geometry.meshes.push({ ...f.mesh, expressId: 20, ifcType: "IfcSpace", positions: f.mesh.positions.slice() });';
  const a = await completed(setup), b = await completed(setup + 'f.geometry.meshes[1].positions[0] = 2;');
  assert.equal(a.row.viewportInputSha256, b.row.viewportInputSha256);
  assert.notEqual(a.row.producedSha256, b.row.producedSha256);
  assert.throws(() => requireViewerInputIdentityPair(a.row, b.row), /producedSha256/);
});
test('#6537 candidate filter and policy changes differ even when its scene matches', async () => {
  const a = await completed(), b = await completed('f.notify({ typeVisibility: { ...f.store.getState().typeVisibility, spaces: true } });');
  assert.equal(a.row.producedSha256, b.row.producedSha256);
  assert.notEqual(a.row.viewportInputSha256, b.row.viewportInputSha256);
  assert.throws(() => requireViewerInputIdentityPair(a.row, b.row), /viewportInputSha256/);
});
test('#6537 merged contributors are independent expected owners, representative is not invented', async () => {
  const a = fixture(); a.install(a.options); a.f.begin(); a.go('f.mesh.entityIds = new Uint32Array([11, 11, 12]); placed = { ...f.mesh, origin: [0,0,0] }; f.scene.meshDataMap.clear(); f.scene.meshDataMap.set(11,[placed]); f.scene.meshDataMap.set(12,[placed]);');
  const row = await a.capture(a.limits); assert.equal(row.owners, 2);
  const b = fixture(); b.install(b.options); b.f.begin(); b.go('f.mesh.entityIds = new Uint32Array([10,10,11]);');
  await assert.rejects(b.capture(b.limits), /independent retained flat piece multiset mismatch/);
});
test('#6537 missing retained instance owner or occurrence refuses against actual inputs', async () => {
  const a = fixture(); a.install(a.options); a.f.begin(); a.f.deliver(a.f.makeShard([42, 43])); a.f.scene.instancedEntityMap.delete(43);
  await assert.rejects(a.capture(a.limits), /incomplete retained occurrence coverage/);
  const b = fixture(); b.install(b.options); b.f.begin(); b.f.deliver(b.f.makeShard([42, 42])); b.f.scene.instancedEntityMap.get(42).pop();
  await assert.rejects(b.capture(b.limits), /incomplete retained occurrence/);
});
test('#6537 one versus two shard grouping preserves full decoded identity and multiplicity', async () => {
  const a = await completed('', [[42, 43]]), b = await completed('', [[42], [43]]);
  assert.equal(a.row.viewportInputSha256, b.row.viewportInputSha256);
  assert.equal(a.row.producedSha256, b.row.producedSha256);
  assert.notEqual(a.row.rawInstancedInputSha256, b.row.rawInstancedInputSha256);
  assert.equal(requireViewerInputIdentityPair(a.row, b.row).identityEqual, true);
});
test('#6537 exact legacy full-produced digest formula is retained on supported input', async () => {
  const { c, row } = await completed(); const legacy = await c.legacy(c.limits);
  assert.equal(row.producedSha256, legacy.sha256);
});
test('#6537 current discovery rejects stale alternate props under the same current HostRoot', () => {
  const c = fixture(); c.go('stale = { ...f.fiber, memoizedProps: { geometry: ["wrong"] } }; stale.return=f.root; f.fiber.child.return=stale;');
  const found = c.discovery(); assert.strictEqual(found.props, c.f.fiber.memoizedProps);
  assert.notStrictEqual(found.props, c.stale.memoizedProps);
  c.go('f.root.child = null;'); assert.throws(c.discovery, /absent from committed current subtree/);
});
test('#6537 unknown tail, future stride and transparent input refuse prospectively', async () => {
  const a = fixture(); a.install(a.options); a.f.begin(); const item = a.f.makeShard(); new Uint32Array(item.buffer, 0, 8)[1] = 4; a.f.deliver(item);
  await assert.rejects(a.capture(a.limits), /raw wire envelope/);
  const b = fixture(); b.install(b.options); b.f.begin(); const transparent = b.f.makeShard(); transparent.shard.instances[0].color[3] = 0.5; b.f.deliver(transparent);
  await assert.rejects(b.capture(b.limits), /not fully opaque/);
});

test('#6537 a missing second flat piece still refuses when its owner remains present', async () => {
  const c = fixture(); c.install(c.options); c.f.begin();
  c.go('second = { ...f.mesh, color: [0,1,0,1] }; f.fiber.memoizedProps.geometry.push(second); f.scene.meshDataMap.get(10).push({ ...second, origin: [0,0,0] });');
  // A legitimate two-piece input is complete before the negative case.
  const positive = fixture(); positive.install(positive.options); positive.f.begin();
  positive.go('second = { ...f.mesh, color: [0,1,0,1] }; f.fiber.memoizedProps.geometry.push(second); f.scene.meshDataMap.get(10).push({ ...second, origin: [0,0,0] });');
  assert.equal((await positive.capture(positive.limits)).owners, 1);
  c.go('f.scene.meshDataMap.get(10).pop();');
  assert.equal(c.f.scene.meshDataMap.has(10), true);
  await assert.rejects(c.capture(c.limits), /independent retained flat piece multiset mismatch/);
});
test('#6537 duplicated retained flat occurrence refuses even with unchanged owner set', async () => {
  const c = fixture(); c.install(c.options); c.f.begin();
  c.go('f.scene.meshDataMap.get(10).push(f.scene.meshDataMap.get(10)[0]);');
  await assert.rejects(c.capture(c.limits), /independent retained flat piece multiset mismatch/);
});
test('#6537 retained flat position, color and finish changes refuse against independent input', async () => {
  for (const change of [
    'piece.positions = piece.positions.slice(); piece.positions[0] = 7;',
    'piece.color = [0,1,0,1];',
    'piece.material = { metallic: 0.8, roughness: 0.1 };',
  ]) {
    const c = fixture(); c.install(c.options); c.f.begin(); c.go(`piece = f.scene.meshDataMap.get(10)[0]; ${change}`);
    await assert.rejects(c.capture(c.limits), /independent retained flat piece multiset mismatch/);
  }
});
test('#6537 actual filtered viewport changes identity with unchanged complete produced bytes', async () => {
  const a = await completed(), b = await completed('f.fiber.memoizedProps.geometry = []; f.scene.meshDataMap.clear();');
  assert.equal(a.row.producedSha256, b.row.producedSha256);
  assert.notEqual(a.row.viewportInputSha256, b.row.viewportInputSha256);
  assert.throws(() => requireViewerInputIdentityPair(a.row, b.row), /viewportInputSha256/);
});
test('#6537 zero-placement admits absent origin and preserves audited signed-zero source semantics', async () => {
  const absent = await completed(); assert.equal(absent.row.viewportMeshes, 1);
  const c = fixture(); c.install(c.options); c.f.begin();
  c.go(`f.mesh.origin = [-0,2,-0];
    f.mesh.localToWorld = [1,0,0,-0,0,1,0,-0,0,0,1,-0,0,0,0,1];
    f.mesh.geometryAabb = { min: [-0,0,-0], max: [1,2,3] };
    placed = { ...f.mesh, origin: [0,2,0],
      localToWorld: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
      geometryAabb: { min: [0,0,0], max: [1,2,3] } };
    f.scene.meshDataMap.set(10, [placed]);`);
  assert.equal((await c.capture(c.limits)).owners, 1);
  assert.equal(Object.is(c.f.mesh.origin[0], -0), true);
  assert.equal(Object.is(c.f.scene.meshDataMap.get(10)[0].origin[0], -0), false);
});
test('#6537 malformed retained origin, matrix and AABB cannot be normalized into eligibility', async () => {
  for (const change of ['piece.origin = [1,0,0];',
    'piece.localToWorld = [1,0,0,2,0,1,0,0,0,0,1,0,0,0,0,1];',
    'piece.geometryAabb = { min: [0,0,0], max: [2,2,2] };']) {
    const c = fixture(); c.install(c.options); c.f.begin(); c.go(`piece = f.scene.meshDataMap.get(10)[0]; ${change}`);
    await assert.rejects(c.capture(c.limits), /independent retained flat piece multiset mismatch/);
  }
});
test('#6537 exact streaming index boundary passes and first oversized triangle explicitly refuses', async () => {
  const at = fixture(); at.install(at.options);
  at.go('f.mesh.indices = new Uint32Array(180000); f.geometry.totalTriangles = 60000;'); at.f.begin();
  assert.equal((await at.capture(at.limits)).viewportMeshes, 1);
  const over = fixture(); over.install(over.options);
  over.go('f.mesh.indices = new Uint32Array(180003); f.geometry.totalTriangles = 60001;'); over.f.begin();
  await assert.rejects(over.capture(over.limits), /zero-placement streaming split unsupported/);
});
