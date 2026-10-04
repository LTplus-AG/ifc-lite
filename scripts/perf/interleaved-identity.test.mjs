/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureIdentity } from './interleaved-identity.mjs';
import { LIMITS } from './interleaved-plan.mjs';

// Stated invariant: every covered raw channel changes identity, including
// instanced-only owners. These are typed payload fixtures, not a mock result.
function fixture(t) {
  const mesh = { expressId: 10, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    color: [1, 0, 0, 1] };
  const packed = new ArrayBuffer(88), view = new DataView(packed);
  for (const offset of [0, 20, 40, 60]) view.setFloat32(offset, 1, true);
  view.setUint32(64, 42, true); view.setFloat32(68, 1, true); view.setFloat32(80, 1, true);
  const template = { modelIndex: 0, positions: mesh.positions.slice(), normals: mesh.normals.slice(),
    indices: mesh.indices.slice(), instanceData: packed, canonicalAnchors: new Float64Array([1, 2, 3]),
    canonicalMatrixTranslations: new Float32Array([1, 2, 3]), localMin: [0, 0, 0], localMax: [1, 1, 0] };
  const scene = { instancedTemplateCpu: [template],
    instancedEntityMap: new Map([[42, [{ templateIndex: 0, byteOffset: 0, originalColor: [1, 0, 0, 1], finishBits: 0 }]]]),
    getAllMeshDataExpressIds: () => [10, ...scene.instancedEntityMap.keys()],
    getInstancedEntityCount: () => scene.instancedEntityMap.size,
    isGeometryDataReleased: () => false,
    getInstancedTemplates: () => [{ instanceCount: 1 }] };
  const geometry = { meshes: [mesh], coordinateInfo: {}, totalVertices: 6, totalTriangles: 2 };
  const data = { entities: { count: 2 }, properties: { count: 0, getForEntity: () => [] },
    entityIndex: { byType: new Map([['IfcWall', [10, 42]]]) } };
  const model = { loadState: 'complete', geometryResult: geometry, ifcDataStore: data };
  const state = { models: new Map([['one', model]]), loading: false, geometryStreamingActive: false };
  const renderer = { isReady: () => true, getScene: () => scene };
  const canvas = { __reactFiber$test: { tag: 0, return: null,
    memoizedState: { next: null, memoizedState: { current: renderer } } } };
  for (const [key, value] of Object.entries({ document: { querySelector: () => canvas },
    __ifc_lite_viewer_store__: { getState: () => state } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  return { mesh, template, scene, state, data, model, canvas };
}

// The collector seam receives typed produced payloads and a private CPU owner
// map. Assertions below test collector evidence/refusal, not Scene ingestion.
function ownerFixture(t) {
  const result = fixture(t), { mesh, scene, state, canvas, model } = result;
  mesh.ifcType = 'IfcWall'; mesh.geometryClass = 0;
  scene.meshDataMap = new Map([[10, [mesh]]]);
  scene.getAllMeshDataExpressIds = () => [...new Set([...scene.meshDataMap.keys(), ...scene.instancedEntityMap.keys()])];
  state.typeViewMode = 'model';
  state.typeVisibility = { spaces: false, spatialZones: false, openings: false, virtualElements: false,
    site: true, ifcAnnotations: true, ifcGrid: true };
  state.hiddenEntities = new Set(); state.isolatedEntities = null; state.ghostExceptEntities = null;
  model.visible = true;
  canvas.__reactFiber$test.memoizedProps = { geometry: [mesh], computedIsolatedIds: null,
    geometryVersion: 3, geometryContentVersion: 0 };
  const root = { tag: 3, return: null };
  root.stateNode = { current: root }; canvas.__reactFiber$test.return = root;
  return result;
}
async function ownerRefusal() {
  let diagnostic;
  await assert.rejects(captureIdentity(LIMITS), error => {
    const prefix = 'REFUSE identity: flat/instance scene owner census mismatch; ownerDiagnostic=';
    assert.ok(error.message.startsWith(prefix), error.message);
    diagnostic = JSON.parse(error.message.slice(prefix.length));
    return true;
  });
  return diagnostic;
}

test('#6537 hidden-type refusal retains unfiltered owners separately from actual viewport input', async t => {
  const { mesh, model, state } = ownerFixture(t);
  model.geometryResult.meshes.push({ ...mesh, expressId: 20, ifcType: 'IfcSpace' });
  const diagnostic = await ownerRefusal();
  assert.deepEqual(diagnostic.missing, [20]); assert.deepEqual(diagnostic.extra, []);
  assert.equal(diagnostic.policy.typeVisibility.spaces, state.typeVisibility.spaces);
  assert.equal(diagnostic.producedUnfiltered.meshes, 2); assert.equal(diagnostic.viewportInput.meshes, 1);
  assert.deepEqual(diagnostic.producedUnfiltered.mismatchIdDetails[0], {
    id: 20, representativePieces: 1, mergedContributorPieces: 0, classes: [0], types: ['IfcSpace'],
    complete: true, omittedClassOccurrences: 0, omittedTypeOccurrences: 0 });
  assert.deepEqual(diagnostic.viewportInput.mismatchIdDetails, []);
  assert.equal(diagnostic.sceneOwnerDetails[0].flatPieces, 0);
  // Observation identifies different populations; it does not waive refusal
  // or claim the visibility switch caused this particular scene census.
  assert.equal(diagnostic.policy.effectiveViewMode, 'not directly observed');
});
test('#6537 orphan-type refusal records actual class and requested view without changing owner rules', async t => {
  const { mesh, model } = ownerFixture(t);
  model.geometryResult.meshes.push({ ...mesh, expressId: 30, geometryClass: 1, ifcType: 'IfcWallType' });
  const diagnostic = await ownerRefusal();
  assert.deepEqual(diagnostic.missing, [30]);
  assert.deepEqual(diagnostic.producedUnfiltered.classes, [[0, 1], [1, 1]]);
  assert.deepEqual(diagnostic.viewportInput.classes, [[0, 1]]);
  assert.equal(diagnostic.producedUnfiltered.mismatchIdDetails[0].types[0], 'IfcWallType');
  assert.equal(diagnostic.policy.requestedTypeViewMode, 'model');
});
test('#6537 merged-contributor census retains extra owner and distinct counts rather than vertex repetition', async t => {
  const { mesh, scene } = ownerFixture(t);
  mesh.entityIds = new Uint32Array([10, 10, 11]);
  scene.meshDataMap.set(11, [mesh]);
  const diagnostic = await ownerRefusal();
  assert.deepEqual(diagnostic.missing, []); assert.deepEqual(diagnostic.extra, [11]);
  for (const population of [diagnostic.producedUnfiltered, diagnostic.viewportInput]) {
    assert.equal(population.mergedMeshes, 1); assert.equal(population.contributorReads, 3);
    assert.equal(population.summedDistinctMergedContributors, 2);
    assert.deepEqual(population.mismatchIdDetails[0], {
      id: 11, representativePieces: 0, mergedContributorPieces: 1, classes: [0], types: ['IfcWall'],
      complete: true, omittedClassOccurrences: 0, omittedTypeOccurrences: 0 });
  }
  assert.deepEqual(diagnostic.sceneOwnerDetails[0], { id: 11, flatPieces: 1, instanceOccurrences: 0,
    scannedPieces: 1, complete: true, mergedPiecesObserved: 1, classes: [0], types: ['IfcWall'] });
});
test('#6537 refusal samples bounded IDs while retaining complete difference counts', async t => {
  const { mesh, model } = ownerFixture(t);
  for (let id = 100; id < 180; id++) model.geometryResult.meshes.push({ ...mesh, expressId: id });
  const diagnostic = await ownerRefusal();
  assert.equal(diagnostic.missingCount, 80); assert.equal(diagnostic.missing.length, 64);
  assert.deepEqual(diagnostic.missing, Array.from({ length: 64 }, (_, index) => index + 100));
  assert.equal(diagnostic.samplesComplete, false);
  assert.equal(diagnostic.producedUnfiltered.mismatchIdDetails.length, 16);
  assert.equal(diagnostic.producedUnfiltered.omittedDetailOccurrences, 48);
  assert.equal(diagnostic.producedUnfiltered.complete, false);
});
test('#6537 bounded contributor traversal labels partial counts and preserves refusal', async t => {
  const { mesh, scene } = ownerFixture(t);
  mesh.entityIds = new Uint32Array(1000001); mesh.entityIds.fill(10); mesh.entityIds[0] = 11;
  scene.meshDataMap.set(11, [mesh]);
  const diagnostic = await ownerRefusal();
  assert.deepEqual(diagnostic.extra, [11]);
  assert.equal(diagnostic.producedUnfiltered.contributorReads, 1000000);
  assert.equal(diagnostic.producedUnfiltered.complete, false);
  assert.equal(diagnostic.viewportInput.complete, false);
});
test('#6537 bounded owner detail values report omitted occurrences and partial population', async t => {
  const { mesh, model } = ownerFixture(t);
  // Typed collector payloads exercise its reporting bound, not IFC ingestion.
  // Repeated omitted values count occurrences, not distinct classes/types.
  for (const [geometryClass, ifcType] of [[0, 'IfcWall'], [1, 'IfcSlab'], [3, 'IfcDoor'],
    [4, 'IfcWindow'], [5, 'IfcColumn'], [5, 'IfcColumn']]) {
    model.geometryResult.meshes.push({ ...mesh, expressId: 20, geometryClass, ifcType });
  }
  const diagnostic = await ownerRefusal();
  assert.deepEqual(diagnostic.missing, [20]);
  const detail = diagnostic.producedUnfiltered.mismatchIdDetails[0];
  assert.deepEqual(detail.classes, [0, 1, 3, 4]);
  assert.deepEqual(detail.types, ['IfcWall', 'IfcSlab', 'IfcDoor', 'IfcWindow']);
  assert.equal(detail.representativePieces, 6);
  assert.equal(detail.omittedClassOccurrences, 2); assert.equal(detail.omittedTypeOccurrences, 2);
  assert.equal(detail.complete, false); assert.equal(diagnostic.producedUnfiltered.complete, false);
  assert.equal(diagnostic.viewportInput.complete, true);
});
test('#6537 unavailable policy and ambiguous input remain explicit refusal evidence', async t => {
  const { mesh, model, state, canvas } = ownerFixture(t);
  model.geometryResult.meshes.push({ ...mesh, expressId: 20 });
  delete state.typeVisibility; delete state.typeViewMode;
  canvas.__reactFiber$test.return = { tag: 0, return: null,
    memoizedState: canvas.__reactFiber$test.memoizedState, memoizedProps: { geometry: [] } };
  const diagnostic = await ownerRefusal();
  assert.equal(diagnostic.policy.requestedTypeViewMode, 'unavailable');
  assert.equal(diagnostic.policy.typeVisibility.spaces, 'unavailable');
  assert.deepEqual(diagnostic.viewportInput, { available: false });
  assert.match(diagnostic.viewportInputSource, /ambiguous/);
});
test('#6537 available policy/input witnesses do not change successful produced identity', async t => {
  const result = fixture(t), baseline = (await captureIdentity(LIMITS)).sha256;
  result.canvas.__reactFiber$test.memoizedProps = { geometry: [] };
  result.state.typeViewMode = 'types'; result.state.typeVisibility = { spaces: false };
  assert.equal((await captureIdentity(LIMITS)).sha256, baseline);
});
test('#6537 noncurrent React branch cannot be labelled actual viewport input', async t => {
  const { mesh, model, canvas } = ownerFixture(t);
  model.geometryResult.meshes.push({ ...mesh, expressId: 20 });
  canvas.__reactFiber$test.return.stateNode.current = { tag: 3 };
  const diagnostic = await ownerRefusal();
  assert.deepEqual(diagnostic.missing, [20]);
  assert.deepEqual(diagnostic.viewportInput, { available: false });
  assert.equal(diagnostic.viewportInputSource, 'current FiberRoot branch not verified');
});

test('#6537 raw flat position/normal/index/appearance channels each affect identity', async t => {
  const { mesh } = fixture(t), baseline = (await captureIdentity(LIMITS)).sha256;
  for (const [key, index, value] of [['positions', 0, 0.25], ['normals', 0, 0.5], ['indices', 0, 1], ['color', 0, 0.75]]) {
    const before = mesh[key][index]; mesh[key][index] = value;
    assert.notEqual((await captureIdentity(LIMITS)).sha256, baseline, key);
    mesh[key][index] = before;
  }
});
test('#6537 raw instance matrices/colors/anchors/normals and canonical translations affect identity', async t => {
  const { template } = fixture(t), baseline = (await captureIdentity(LIMITS)).sha256;
  for (const [key, value] of [['normals', 0.5], ['canonicalAnchors', 1.00000000001], ['canonicalMatrixTranslations', 0.125]]) {
    const before = template[key][0]; template[key][0] = value;
    assert.notEqual((await captureIdentity(LIMITS)).sha256, baseline, key); template[key][0] = before;
  }
  const view = new DataView(template.instanceData);
  for (const offset of [0, 68, 84]) {
    const before = view.getUint32(offset, true); view.setUint32(offset, before ^ 1, true);
    assert.notEqual((await captureIdentity(LIMITS)).sha256, baseline, `packed byte ${offset}`);
    view.setUint32(offset, before, true);
  }
});
test('#6537 duplicate flat pieces are retained while publication order is irrelevant', async t => {
  const { mesh, model } = fixture(t);
  const baseline = (await captureIdentity(LIMITS)).sha256;
  model.geometryResult.meshes.push({ ...mesh, positions: mesh.positions.slice() });
  const duplicate = (await captureIdentity(LIMITS)).sha256;
  assert.notEqual(duplicate, baseline);
  // #6737: distinct contents are required to observe publication sorting;
  // reversing two byte-identical pieces cannot detect a missing sort.
  const distinct = { ...mesh, positions: mesh.positions.slice() };
  distinct.positions[0] = 0.25;
  model.geometryResult.meshes.push(distinct);
  const ordered = (await captureIdentity(LIMITS)).sha256;
  assert.notEqual(ordered, duplicate);
  model.geometryResult.meshes.reverse();
  assert.equal((await captureIdentity(LIMITS)).sha256, ordered);
});
test('#6737 a missing private instance-count method explicitly refuses identity', async t => {
  const { scene } = fixture(t);
  delete scene.getInstancedEntityCount;
  await assert.rejects(captureIdentity(LIMITS), /^Error: REFUSE identity: private scene shape changed$/);
});
test('#6537 unsupported appearance or unknown private fields refuse rather than certify', async t => {
  const { mesh, template, data } = fixture(t);
  mesh.uvs = new Float32Array(6);
  await assert.rejects(captureIdentity(LIMITS), /UV\/texture/); delete mesh.uvs;
  template.newAppearance = 'unsupported';
  await assert.rejects(captureIdentity(LIMITS), /unknown raw template/); delete template.newAppearance;
  data.entityIndex.byType.set('IfcTextLiteral', [99]);
  await assert.rejects(captureIdentity(LIMITS), /text appearance/);
});
test('#6537 missing instance owners, duplicate records and bounded work refuse', async t => {
  const { scene } = fixture(t);
  scene.instancedEntityMap.get(42).push({ ...scene.instancedEntityMap.get(42)[0] });
  await assert.rejects(captureIdentity(LIMITS), /duplicate occurrence/);
  scene.instancedEntityMap.get(42).pop();
  await assert.rejects(captureIdentity({ ...LIMITS, oneBufferBytes: 4 }), /one buffer/);
  await assert.rejects(captureIdentity({ ...LIMITS, records: 1 }), /walk bound/);
  scene.instancedEntityMap.clear();
  await assert.rejects(captureIdentity(LIMITS), /unowned retained template/);
});

test('#6537 released CPU arrays cannot produce a successful empty geometry fingerprint', async t => {
  const { scene, template, mesh } = fixture(t);
  scene.isGeometryDataReleased = () => true;
  await assert.rejects(captureIdentity(LIMITS), /CPU geometry released/);
  scene.isGeometryDataReleased = () => false;
  template.positions = new Float32Array(); template.normals = new Float32Array(); template.indices = new Uint32Array();
  await assert.rejects(captureIdentity(LIMITS), /instance shape/);
  scene.instancedEntityMap.clear(); scene.instancedTemplateCpu = [];
  mesh.positions = new Float32Array(); mesh.normals = new Float32Array(); mesh.indices = new Uint32Array();
  await assert.rejects(captureIdentity(LIMITS), /flat raw buffer/);
});

test('#6537 identity rejects incomplete Hook discovery and accepts non-Hook parent state', async t => {
  const { canvas } = fixture(t);
  const baseline = (await captureIdentity(LIMITS)).sha256;
  const hook = canvas.__reactFiber$test.memoizedState;
  hook.next = hook;
  await assert.rejects(captureIdentity(LIMITS), /hook cycle/);
  hook.next = null;
  const root = { tag: 3, return: null, memoizedState: {} };
  root.memoizedState.next = root.memoizedState;
  canvas.__reactFiber$test.return = root;
  assert.equal((await captureIdentity(LIMITS)).sha256, baseline);
  canvas.__reactFiber$test.return = null;
  let tail = null;
  for (let index = 0; index < 2048; index++) tail = { next: tail, memoizedState: null };
  hook.next = tail;
  await assert.rejects(captureIdentity(LIMITS), /hook discovery budget exhausted/);
  hook.next = null;
  canvas.__reactFiber$test.tag = undefined;
  await assert.rejects(captureIdentity(LIMITS), /unknown React fiber tag/);
});
