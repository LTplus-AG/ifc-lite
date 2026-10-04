/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { webcrypto, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { captureViewerInputDiagnostic } from './input-witness-diagnostic.mjs';
import { canonicalEmptyBytes, produceCanonicalEmpty } from './input-witness-empty-fixture.mjs';
import { tsImport } from 'tsx/esm/api';
import { discoverViewerInput } from './input-witness-discovery.mjs';
import { installViewerInputWitness } from './input-witness-install.mjs';
import { captureViewerInputIdentity } from './input-witness-capture.mjs';
import { expectedZeroPlacedMesh } from './input-witness-zero-placement.mjs';
import { captureIdentity } from './interleaved-identity.mjs';
import { boundedGpuBytes, triangleCompatibilityBytes, GPU_USAGE, RUST_GOLDEN_HEX } from './input-witness-canonical-fixtures.mjs';

// Source imports use the existing viewer aliases. No copied or stale dist is
// selected as a fallback. Root Turbo qualification remains authoritative.
const sourceDir = process.env.BASE_DIR ?? fileURLToPath(new URL('../../', import.meta.url));
if (process.env.BASE_DIR && execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim()
  !== '7dfc29870b0aa6a593c163592fcb84a92e5dfa19') throw new Error('REFUSE: canonical fixture subject mismatch');
const options = { parentURL: import.meta.url, tsconfig: join(sourceDir, 'apps/viewer/tsconfig.json') };
const [{ Scene }, { decodeInstancedShard }, { prepareInstancedRender, packInstanceFinish },
  { createDataSlice }, { geometryWithModelIndex }] = await Promise.all([
  tsImport(join(sourceDir, 'packages/renderer/src/scene.ts'), options),
  tsImport(join(sourceDir, 'packages/geometry/src/packed-instanced-decoder.ts'), options),
  tsImport(join(sourceDir, 'packages/renderer/src/instanced-render.ts'), options),
  tsImport(join(sourceDir, 'apps/viewer/src/store/slices/dataSlice.ts'), options),
  tsImport(join(sourceDir, 'apps/viewer/src/lib/model-placement/model-indices.ts'), options),
]);
// Zustand belongs to the consuming viewer package, not a new root dependency.
const { createStore } = createRequire(join(sourceDir, 'apps/viewer/package.json'))('zustand/vanilla');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let nextModel = 0;

function control() {
  const globals = ['document', 'GPUBufferUsage', 'crypto', '__ifc_lite_viewer_store__'];
  const descriptors = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  assert.equal(globalThis.__ifc_lite_input_witness__, undefined, 'previous witness must be disposed');
  const scene = new Scene(), gpu = boundedGpuBytes(), modelId = `canonical-input-${++nextModel}`;
  const metadata = { entities: { count: 3 }, properties: { count: 0, getForEntity() { return []; } },
    entityIndex: { byType: new Map([['IfcWall', [10, 42, 43]]]) } };
  const mesh = { expressId: 10, ifcType: 'IfcWall', color: [1, 0, 0, 1], geometryClass: 0,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
  const geometry = { meshes: [mesh], coordinateInfo: {}, totalVertices: 3, totalTriangles: 1 };
  const api = createStore((set, get, storeApi) => ({ ...createDataSlice(set, get, storeApi),
    activeModelId: null, models: new Map(), loading: false, geometryStreamingActive: false,
    appliedEntityLevelOffsets: new Map(), hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null,
    typeViewMode: 'model', hasTypeGeometry: true, typeVisibility: { spaces: false, spatialZones: false,
      openings: false, virtualElements: false, site: true, ifcAnnotations: true, ifcGrid: true } }));
  const store = Object.assign(function () { throw new Error('Store hook must not be invoked'); }, api);
  // Only readiness/GPU facade and DOM discovery are adapted. Scene, placement,
  // packing, decoded views and retained owner data are never mocked or seeded.
  const renderer = { getScene() { return scene; }, getGPUDevice() { return gpu.device; }, isReady() { return true; } };
  const props = { geometry: null, modelIdToIndex: new Map([[modelId, 0]]), computedIsolatedIds: null, coordinateInfo: {} };
  const canvas = {}, root = { tag: 3, child: null, sibling: null, return: null };
  root.stateNode = { current: root };
  const parent = { tag: 0, memoizedProps: props, memoizedState: { memoizedState: { current: renderer }, next: null },
    return: root, sibling: null, child: null };
  const host = { tag: 5, stateNode: canvas, child: null, sibling: null, return: parent };
  root.child = parent; parent.child = host; canvas.__reactFiber$canonical = host;
  const values = { document: { querySelector() { return canvas; } }, GPUBufferUsage: GPU_USAGE,
    crypto: webcrypto, __ifc_lite_viewer_store__: store };
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  const originalAdd = scene.addInstancedShard;
  let registration;
  try {
    registration = installViewerInputWitness({ discoverySource: discoverViewerInput.toString(),
      bounds: { deliveries: 100, retainedBytes: 1024 ** 2, calls: 100 },
      // This is a test payload, not authenticated subject/build provenance.
      referenceAudit: { subjectHead: 'c61932d4a9d85efe1b0f817a5274a115f0571ee3', manifestSha256: 'a'.repeat(64), immutableArguments: true } });
  } catch (error) {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
    throw error;
  }
  const limits = { oneBufferBytes: 1024 ** 2, digestBytes: 16 * 1024 ** 2, records: 100000,
    zeroPlacementSource: expectedZeroPlacedMesh.toString() };
  function begin(meshes = [mesh]) {
    geometry.meshes = meshes;
    geometry.totalVertices = meshes.reduce((n, part) => n + part.positions.length / 3, 0);
    geometry.totalTriangles = meshes.reduce((n, part) => n + part.indices.length / 3, 0);
    api.setState({ activeModelId: modelId, models: new Map([[modelId,
      { id: modelId, visible: true, idOffset: 0, loadState: 'complete', geometryResult: geometry, ifcDataStore: metadata }]]),
    geometryResult: geometry, ifcDataStore: metadata });
    props.geometry = geometryWithModelIndex(geometry, 0).meshes;
    for (const part of props.geometry) scene.addMeshData(part);
  }
  function ingest(bytes, publish = true) {
    if (publish) api.getState().appendInstancedShards(modelId, [bytes]);
    // The same canonical calls as the primary zero-offset/empty-level drain;
    // the actual React useGeometryStreaming effect is outside this API seam.
    const decoded = decodeInstancedShard(new Uint8Array(bytes));
    const result = scene.addInstancedShard(gpu.device, decoded, 0);
    api.getState().clearInstancedShards();
    return { decoded, result };
  }
  function cleanup() {
    try {
      globalThis.__ifc_lite_input_witness__?.dispose();
      assert.strictEqual(scene.addInstancedShard, originalAdd, 'native prototype method restored');
      assert.equal(Object.hasOwn(scene, 'addInstancedShard'), false);
      scene.clear();
      assert.equal(gpu.liveCount, 0, 'real Scene teardown destroys every allocated test buffer');
      assert.equal(gpu.liveBytes, 0);
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
      }
    }
  }
  return { scene, gpu, api, props, mesh, geometry, registration, limits, begin, ingest, cleanup,
    capture() { return captureViewerInputIdentity(limits); } };
}

test('#6537 real store delivery and decoder arguments survive transient canonical ingestion', () => {
  const c = control();
  try {
    c.begin(); const bytes = triangleCompatibilityBytes(), before = sha(new Uint8Array(bytes));
    const { decoded, result } = c.ingest(bytes);
    assert.equal(result, undefined);
    const frozen = globalThis.__ifc_lite_input_witness__.freeze();
    assert.equal(frozen.deliveries.length, 1); assert.equal(frozen.inputs.length, 1);
    assert.strictEqual(frozen.deliveries[0].buffer, bytes);
    assert.strictEqual(frozen.inputs[0].shard, decoded); assert.equal(frozen.inputs[0].accepted, true);
    assert.strictEqual(decoded.templates[0].positions.buffer, bytes);
    assert.strictEqual(c.scene.instancedTemplateCpu[0].positions, decoded.templates[0].positions);
    assert.equal(c.api.getState().pendingInstancedShards, null);
    assert.equal(c.scene.getInstancedEntityCount(), 2);
    assert.equal(sha(new Uint8Array(bytes)), before, 'canonical path leaves original source bytes unchanged');
  } finally { c.cleanup(); }
});

test('#6537 real decoder, preparation, placement and Scene qualify supported triangle identity', async () => {
  const c = control();
  try {
    c.begin(); const bytes = triangleCompatibilityBytes(), before = sha(new Uint8Array(bytes));
    const { decoded } = c.ingest(bytes), cpu = c.scene.instancedTemplateCpu[0], gpu = c.scene.getInstancedTemplates()[0];
    const prepared = prepareInstancedRender(decoded)[0];
    assert.deepEqual(new Uint8Array(cpu.instanceData), new Uint8Array(prepared.instanceBuffer));
    assert.deepEqual(c.gpu.bytes(gpu.instanceBuffer), new Uint8Array(cpu.instanceData));
    // Independent stated transform/origin expectation: (2,-3,5)+(7,11,13)
    // maps Z-up to Y-up (9,18,-8), not the adapter's own return value.
    assert.deepEqual(Array.from(cpu.canonicalAnchors.slice(0, 3)), [9, 18, -8]);
    assert.deepEqual(Array.from(cpu.canonicalAnchors.slice(3, 6)), [8, 8, -4]);
    const row = c.scene.instancedEntityMap.get(42)[0];
    assert.equal(row.itemId, 500); assert.equal(row.finishBits, packInstanceFinish(0.25, 0.75));
    assert.deepEqual(row.originalColor, [0.25, 0.5, 0.75, 1]);
    const identity = await c.capture(); assert.equal(identity.occurrences, 2); assert.equal(identity.owners, 3);
    assert.equal(identity.producedSha256, (await captureIdentity(c.limits)).sha256);
    assert.equal(sha(new Uint8Array(bytes)), before);
  } finally { c.cleanup(); }
});

test('#6537 unchanged Rust-produced v1/v2 decode through real Scene but strict triangle identity refuses', async () => {
  const expected = { v1: '74ec1798793a265d1900538a839631f07ebd573e35f02fb455adb41a37d8696a',
    v2: 'f20ad75faebfd6e4ba22739e363308ee2dd86ee470112c6501879eff45377a19' };
  for (const version of ['v1', 'v2']) {
    const c = control();
    try {
      c.begin(); const raw = Uint8Array.from(Buffer.from(RUST_GOLDEN_HEX[version], 'hex')), bytes = raw.buffer;
      assert.equal(sha(raw), expected[version]);
      const { decoded } = c.ingest(bytes);
      assert.deepEqual(decoded.instances.map(instance => instance.entityId), [1000, 1001, 1002]);
      assert.equal(c.scene.getInstancedEntityCount(), 3); assert.equal(c.scene.instancedTemplateCpu.length, 2);
      assert.strictEqual(c.scene.instancedTemplateCpu[0].positions, decoded.templates[0].positions);
      await assert.rejects(c.capture(), /empty\/malformed\/unowned template input unsupported/);
      assert.equal(sha(raw), expected[version], 'historical golden is never repaired or regenerated');
    } finally { c.cleanup(); }
  }
});

test('#6537 canonical merged contributors and same-owner piece multiplicity qualify then missing piece refuses', async () => {
  const positive = control();
  try {
    const merged = { ...positive.mesh, entityIds: new Uint32Array([11, 11, 12]) };
    const second = { ...positive.mesh, color: [0, 1, 0, 1] };
    positive.begin([merged, positive.mesh, second]);
    assert.equal(positive.scene.meshDataMap.get(10).length, 2);
    assert.strictEqual(positive.scene.meshDataMap.get(11)[0], positive.scene.meshDataMap.get(12)[0]);
    assert.equal((await positive.capture()).owners, 3);
  } finally { positive.cleanup(); }
  const negative = control();
  try {
    negative.begin([negative.mesh, { ...negative.mesh, color: [0, 1, 0, 1] }]);
    negative.scene.meshDataMap.get(10).pop(); // Deliberate retained-output corruption only.
    await assert.rejects(negative.capture(), /independent retained flat piece multiset mismatch/);
  } finally { negative.cleanup(); }
});

test('#6537 actual zero-placement origin, matrix and AABB agree while source signed zeros remain', async () => {
  const c = control();
  try {
    c.mesh.origin = [-0, 2, -0];
    c.mesh.localToWorld = [1, 0, 0, -0, 0, 1, 0, -0, 0, 0, 1, -0, 0, 0, 0, 1];
    c.mesh.geometryAabb = { min: [-0, 0, -0], max: [1, 2, 3] };
    c.begin(); const placed = c.scene.meshDataMap.get(10)[0];
    assert.equal(Object.is(c.mesh.origin[0], -0), true); assert.equal(Object.is(placed.origin[0], -0), false);
    assert.deepEqual(placed.localToWorld.slice(0, 4), [1, 0, 0, 0]);
    assert.deepEqual(placed.geometryAabb, { min: [0, 0, 0], max: [1, 2, 3] });
    assert.equal((await c.capture()).owners, 1);
  } finally { c.cleanup(); }
});

test('#6537 real first-upload write failure preserves native error and refuses accepted-input proof', () => {
  const c = control();
  try {
    c.begin(); const error = new Error('controlled first native GPU write failure'); c.gpu.failNextWrite(error);
    assert.throws(() => c.ingest(triangleCompatibilityBytes()), actual => actual === error);
    assert.equal(c.gpu.all.length, 1); assert.equal(c.gpu.all[0].destroyed, true);
    assert.equal(c.gpu.liveCount, 0, 'canonical createStaticGpuBuffer cleans its failed first allocation');
    assert.throws(() => globalThis.__ifc_lite_input_witness__.freeze(), /native instance ingestion threw/);
  } finally { c.cleanup(); }
});

test('#6537 real Scene ingestion without the original producer delivery cannot qualify', () => {
  const c = control();
  try {
    c.begin(); c.ingest(triangleCompatibilityBytes(), false);
    assert.equal(c.scene.getInstancedEntityCount(), 2, 'original native path still ingests geometry');
    assert.throws(() => globalThis.__ifc_lite_input_witness__.freeze(), /not linked to original delivery/);
  } finally { c.cleanup(); }
});

test('#6537 canonical Rust empty encoder, real decoder and Scene preserve no-output input', async t => {
  if (!existsSync(join(sourceDir, 'packages/wasm/pkg/ifc-lite_bg.wasm'))) {
    if (process.env.INPUT_WITNESS_EMPTY_REQUIRED === 'true') throw new Error('Required canonical empty producer WASM missing');
    t.skip('run pnpm build:wasm for the no-model canonical empty producer'); return;
  }
  const result = await produceCanonicalEmpty(sourceDir);
  assert.equal(result.flatMeshes, 0); assert.equal(result.occurrences, 0);
  assert.deepEqual(result.bytes, new Uint8Array(canonicalEmptyBytes()));
  const decoded = decodeInstancedShard(result.bytes);
  assert.deepEqual(decoded, { templates: [], instances: [], carriesItemIds: false, carriesFinishes: false });
  assert.deepEqual(prepareInstancedRender(decoded), []);
  const c = control();
  try {
    c.begin();
    const beforeFirst = { live: c.gpu.liveCount, allocations: [...c.gpu.all] };
    c.ingest(canonicalEmptyBytes());
    assert.equal(c.gpu.liveCount, beforeFirst.live, 'first empty native call allocates no GPU buffers');
    assert.deepEqual(c.gpu.all, beforeFirst.allocations, 'first empty call preserves actual allocation list');
    c.ingest(triangleCompatibilityBytes());
    const beforeSecond = { live: c.gpu.liveCount, allocations: [...c.gpu.all] };
    c.ingest(canonicalEmptyBytes());
    assert.equal(c.gpu.liveCount, beforeSecond.live, 'empty call after live geometry allocates no GPU buffers');
    assert.deepEqual(c.gpu.all, beforeSecond.allocations, 'empty call preserves existing allocation list');
    assert.equal(c.scene.instancedTemplateCpu.length, 1); assert.equal(c.scene.getInstancedEntityCount(), 2);
    const identity = await c.capture();
    assert.equal(identity.occurrences, 2); assert.equal(identity.rawInstancedInputs.length, 3);
    assert.equal(identity.decodedShardProvenance.filter(row => row.occurrences === 0).length, 2);
    assert.equal(identity.producedSha256, (await captureIdentity(c.limits)).sha256);
  } finally { c.cleanup(); }
});

test('#6537 missing or duplicate empty native calls refuse original delivery multiplicity', async () => {
  for (const kind of ['drop', 'duplicate', 'without-delivery']) {
    const c = control();
    try {
      c.begin(); const bytes = canonicalEmptyBytes();
      if (kind === 'drop') c.api.getState().appendInstancedShards(c.api.getState().activeModelId, [bytes]);
      else { c.ingest(bytes, kind !== 'without-delivery'); if (kind === 'duplicate') c.ingest(bytes, false); }
      await assert.rejects(c.capture(), /undrained|without canonical undrained delivery/);
      assert.equal(c.scene.getInstancedEntityCount(), 0);
      const diagnostic = await captureViewerInputDiagnostic();
      assert.equal(diagnostic.status, 'refusal-diagnostic-only');
      if (kind !== 'without-delivery') assert.equal(diagnostic.deliveries[0].hash.sha256, sha(new Uint8Array(bytes)));
    } finally { c.cleanup(); }
  }
});

test('#6537 delivered empty buffer mutation remains a terminal immutability refusal', async () => {
  const c = control();
  try {
    c.begin(); const bytes = canonicalEmptyBytes(); c.ingest(bytes);
    new Uint32Array(bytes)[1] = 2;
    await assert.rejects(c.capture(), /undrained/);
    const diagnostic = await captureViewerInputDiagnostic();
    assert.equal(diagnostic.deliveries[0].admittedClass, 'canonical-empty-v1');
    assert.equal(diagnostic.deliveries[0].currentClass, 'nonempty-or-unsupported');
    assert.equal(diagnostic.deliveries[0].headerWords[1], 2);
    assert.equal(diagnostic.deliveries[0].hash.sha256, sha(new Uint8Array(bytes)));
  } finally { c.cleanup(); }
});

test('#6537 malformed or noncanonical no-output packets cannot become accepted progress', async () => {
  for (const kind of ['truncated', 'tail', 'unused-template', 'zero-version']) {
    const c = control();
    try {
      c.begin(); let bytes = canonicalEmptyBytes();
      if (kind === 'truncated') bytes = bytes.slice(0, 31);
      if (kind === 'tail') { const extended = new Uint8Array(36); extended.set(new Uint8Array(bytes)); bytes = extended.buffer; }
      if (kind === 'unused-template') bytes = triangleCompatibilityBytes(3, []);
      if (kind === 'zero-version') new Uint32Array(bytes)[1] = 0;
      if (kind === 'truncated' || kind === 'zero-version') assert.throws(() => c.ingest(bytes), /too small|Unsupported instanced shard version/);
      else c.ingest(bytes);
      await assert.rejects(c.capture(), /undrained|empty call|noncanonical empty/);
      const diagnostic = await captureViewerInputDiagnostic();
      assert.equal(diagnostic.deliveries[0].byteLength, bytes.byteLength);
      assert.equal(diagnostic.deliveries[0].hash.sha256, sha(new Uint8Array(bytes)));
      assert.equal(c.scene.getInstancedEntityCount(), 0);
    } finally { c.cleanup(); }
  }
});

test('#6537 empty native throw is preserved and cannot certify a delivery', async () => {
  const c = control(), before = Object.getOwnPropertyDescriptor(c.scene, 'instancedDevice');
  try {
    c.begin(); Object.defineProperty(c.scene, 'instancedDevice', { configurable: true, writable: false, value: null });
    assert.throws(() => c.ingest(canonicalEmptyBytes()), TypeError, 'actual Scene cached-device assignment fails');
    await assert.rejects(c.capture(), /native instance ingestion threw/);
    assert.equal((await captureViewerInputDiagnostic()).failure, 'native instance ingestion threw');
  } finally {
    if (before) Object.defineProperty(c.scene, 'instancedDevice', before); else delete c.scene.instancedDevice;
    c.cleanup();
  }
});

test('#6537 empty native call changing retained Scene census is refused', async () => {
  const c = control(), before = Object.getOwnPropertyDescriptor(c.scene, 'instancedDevice');
  try {
    c.begin();
    Object.defineProperty(c.scene, 'instancedDevice', { configurable: true,
      get() { return c.gpu.device; }, set() { c.scene.addMeshData({ ...c.mesh, expressId: 11 }); } });
    c.ingest(canonicalEmptyBytes());
    assert.equal(c.scene.meshDataMap.has(11), true, 'actual canonical retention changed during native cached-device assignment');
    await assert.rejects(c.capture(), /empty native return\/retained census changed/);
  } finally {
    if (before) Object.defineProperty(c.scene, 'instancedDevice', before); else delete c.scene.instancedDevice;
    c.cleanup();
  }
});
