/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Independently interpreting collector fixture, NOT real GPU/Scene qualification.
// Self-contained so VM controls use their own typed-array/object prototypes.
export function inputWitnessFixture() {
  const mesh = { expressId: 10, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    color: [1, 0, 0, 1], geometryClass: 0, ifcType: 'IfcWall', modelIndex: 0 };
  const geometry = { meshes: [mesh], coordinateInfo: {}, totalVertices: 3, totalTriangles: 1 };
  const data = { entities: { count: 3 }, properties: { count: 0, getForEntity() { return []; } },
    entityIndex: { byType: new Map([['IfcWall', [10, 42, 43]]]) } };
  const model = { visible: true, idOffset: 0, loadState: 'complete', geometryResult: geometry, ifcDataStore: data };
  const listeners = new Set();
  let state = { models: new Map(), loading: false, geometryStreamingActive: false, pendingInstancedShards: null,
    appliedEntityLevelOffsets: new Map(), hiddenEntities: new Set(), isolatedEntities: null, ghostExceptEntities: null,
    typeViewMode: 'model', hasTypeGeometry: true, typeVisibility: { spaces: false, spatialZones: false, openings: false,
      virtualElements: false, site: true, ifcAnnotations: true, ifcGrid: true } };
  function store() { throw new Error('store hook must not be invoked'); }
  store.getState = function () { if (this !== store) throw new Error('store receiver'); return state; };
  store.subscribe = function (listener) {
    if (this !== store) throw new Error('subscription receiver');
    listeners.add(listener); return () => listeners.delete(listener);
  };
  function notify(patch) { state = { ...state, ...patch }; listeners.forEach(listener => listener(state)); }
  const device = {}, nativeCalls = [];
  const scene = { meshDataMap: new Map(), instancedEntityMap: new Map(), instancedTemplateCpu: [],
    instanceSuppression: { retained: false }, instancedHidden: new Set(), instancedSelected: new Set(),
    instancedOverridden: new Set(), instancedGhosted: new Set(), instancedVisible: true,
    isGeometryDataReleased() { return false; }, hasQueuedMeshes() { return false; }, hasStreamingFragments() { return false; },
    hasPendingBatches() { return false; }, isFinalizeInProgress() { return false; }, getModelTranslation() { return [0, 0, 0]; },
    getModelRotation() { return null; },
    getAllMeshDataExpressIds() { return [...new Set([...this.meshDataMap.keys(), ...this.instancedEntityMap.keys()])]; },
    getInstancedEntityCount() { return this.instancedEntityMap.size; },
    getInstancedTemplates() { return this.instancedTemplateCpu.map(t => ({ instanceCount: t.instanceData.byteLength / 88 })); },
    removeMeshesForEntity(id) { return this.meshDataMap.delete(id) || this.instancedEntityMap.delete(id); },
    removeMeshesForEntities(ids) { let n = 0; for (const id of ids) if (this.removeMeshesForEntity(id)) n++; return n; },
    removeInstancedTemplatesForModel() { const n = this.instancedTemplateCpu.length; this.instancedTemplateCpu = []; this.instancedEntityMap.clear(); return n; },
    translateMeshesForEntity(id, delta) { const parts = this.meshDataMap.get(id) ?? []; for (const part of parts) part.positions[0] += delta[0]; return !!parts.length; },
    rotateMeshesForEntity(id) { return this.meshDataMap.has(id); }, retainInstancedOccurrence(id) { this.instanceSuppression.retained = true; return { id }; },
    releaseGeometryData() { this.instancedTemplateCpu = []; }, clear() { this.meshDataMap.clear(); this.instancedEntityMap.clear(); this.instancedTemplateCpu = []; },
    addInstancedShard(incoming, shard, index = 0) {
      nativeCalls.push({ receiver: this, args: [incoming, shard, index] });
      if (incoming !== device) throw new Error('native wrong device');
      if (this.nativeError) throw this.nativeError;
      // Interpret each occurrence independently into row->column Y-up output.
      for (const [templateIndex, template] of shard.templates.entries()) {
        const occurrences = shard.instances.filter(instance => instance.templateIndex === templateIndex);
        if (!occurrences.length) continue;
        const packed = new ArrayBuffer(88 * occurrences.length), view = new DataView(packed);
        const anchors = new Float64Array(occurrences.length * 3), translations = new Float32Array(anchors.length);
        const slot = this.instancedTemplateCpu.length;
        for (const [n, occurrence] of occurrences.entries()) {
          const rm = occurrence.transform, origin = template.origin, matrix = new Float32Array(16);
          for (let c = 0; c < 4; c++) {
            matrix[c * 4] = rm[c]; matrix[c * 4 + 1] = rm[8 + c];
            matrix[c * 4 + 2] = -rm[4 + c]; matrix[c * 4 + 3] = rm[12 + c];
          }
          const anchor = [rm[0] * origin[0] + rm[1] * origin[1] + rm[2] * origin[2] + rm[3],
            rm[8] * origin[0] + rm[9] * origin[1] + rm[10] * origin[2] + rm[11],
            -(rm[4] * origin[0] + rm[5] * origin[1] + rm[6] * origin[2] + rm[7])];
          matrix.set(anchor, 12); anchors.set(anchor, n * 3); translations.set(matrix.subarray(12, 15), n * 3);
          for (let k = 0; k < 16; k++) view.setFloat32(n * 88 + k * 4, matrix[k], true);
          view.setUint32(n * 88 + 64, occurrence.entityId, true);
          for (let k = 0; k < 4; k++) view.setFloat32(n * 88 + 68 + k * 4, occurrence.color[k], true);
          view.setUint32(n * 88 + 84, 0, true);
          const entries = this.instancedEntityMap.get(occurrence.entityId) ?? [];
          entries.push({ templateIndex: slot, byteOffset: n * 88, originalColor: [...occurrence.color], itemId: occurrence.itemId, finishBits: 0 });
          this.instancedEntityMap.set(occurrence.entityId, entries);
        }
        this.instancedTemplateCpu.push({ modelIndex: index, positions: template.positions, normals: template.normals,
          indices: template.indices, instanceData: packed, canonicalAnchors: anchors, canonicalMatrixTranslations: translations,
          localMin: [0, 0, 0], localMax: [1, 1, 0] });
      }
      return this.nativeReturn;
    },
  };
  const renderer = { isReady() { return true; }, getScene() { return scene; }, getGPUDevice() { return device; } };
  const root = { tag: 3, return: null }; root.stateNode = { current: root };
  const fiber = { tag: 0, return: root, memoizedProps: { geometry: null, modelIdToIndex: new Map([['primary', 0]]),
    computedIsolatedIds: null, geometryVersion: 0, geometryContentVersion: 0, coordinateInfo: {} },
    memoizedState: { next: null, memoizedState: { current: renderer } } };
  const canvas = { __reactFiber$fixture: fiber };
  const host = { tag: 5, stateNode: canvas, child: null, sibling: null, return: fiber };
  fiber.child = host; fiber.sibling = null; root.child = fiber; root.sibling = null;
  canvas.__reactFiber$fixture = host;
  globalThis.document = { querySelector() { return canvas; } }; globalThis.__ifc_lite_viewer_store__ = store;
  function makeShard(owners = [42]) {
    const dataOffset = 32 + 48 + owners.length * 88, buffer = new ArrayBuffer(dataOffset + 84), dv = new DataView(buffer);
    new Uint32Array(buffer, 0, 8).set([0x49464e53, 1, 1, owners.length, 9, 9, 3, 0]);
    new Uint32Array(buffer, 32, 6).set([0, 9, 0, 9, 0, 3]);
    const positions = new Float32Array(buffer, dataOffset, 9), normals = new Float32Array(buffer, dataOffset + 36, 9), indices = new Uint32Array(buffer, dataOffset + 72, 3);
    positions.set(mesh.positions); normals.set(mesh.normals); indices.set(mesh.indices);
    const instances = owners.map((entityId, n) => {
      const transform = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const color = [1, 0, 0, 1], base = 80 + n * 88;
      dv.setUint32(base, 0, true); dv.setUint32(base + 4, entityId, true);
      for (let k = 0; k < 4; k++) dv.setFloat32(base + 8 + k * 4, color[k], true);
      for (let k = 0; k < 16; k++) dv.setFloat32(base + 24 + k * 4, transform[k], true);
      return { templateIndex: 0, entityId, color, transform, itemId: undefined, metallic: undefined, roughness: undefined };
    });
    return { buffer, shard: { templates: [{ positions, normals, indices, origin: [0, 0, 0] }], instances, carriesItemIds: false, carriesFinishes: false } };
  }
  function begin() {
    notify({ models: new Map([['primary', model]]) }); fiber.memoizedProps.geometry = [mesh];
    scene.meshDataMap.set(10, [{ ...mesh, origin: [0, 0, 0] }]);
  }
  function deliver(item) {
    notify({ pendingInstancedShards: [...(state.pendingInstancedShards ?? []), { modelId: 'primary', bytes: item.buffer }] });
    const result = scene.addInstancedShard(device, item.shard, 0);
    notify({ pendingInstancedShards: null }); return result;
  }
  return { mesh, geometry, data, model, store, notify, listeners, scene, device, renderer, fiber, root, nativeCalls, makeShard, begin, deliver };
}
