/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Self-contained page.evaluate callback; all work happens AFTER full readiness.
// Deliberately shape-specific. Changing a private shape requires a reviewed protocol.
export async function captureIdentity(limits) {
  const refuse = reason => { throw new Error(`REFUSE identity: ${reason}`); };
  const encoder = new TextEncoder();
  let bytes = 0, records = 0;
  const hex = data => Array.from(new Uint8Array(data), byte => byte.toString(16).padStart(2, '0')).join('');
  async function digest(data) {
    if (data.byteLength > limits.oneBufferBytes) refuse('one buffer exceeds digest bound');
    bytes += data.byteLength;
    if (bytes > limits.digestBytes) refuse('total digest work bound');
    return hex(await crypto.subtle.digest('SHA-256', data));
  }
  async function canonical(value, depth = 0) {
    if (depth > 24 || ++records > limits.records) refuse('canonical walk bound');
    if (value === undefined) return ['absent'];
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return ['bigint', value.toString()];
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) refuse('nonfinite scalar');
      return Object.is(value, -0) ? ['negative-zero'] : value;
    }
    if (ArrayBuffer.isView(value)) {
      if (value.byteLength > limits.oneBufferBytes) refuse('one buffer exceeds digest bound');
      const raw = new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).buffer;
      return [value.constructor.name, value.byteLength, await digest(raw)];
    }
    if (value instanceof ArrayBuffer) return ['ArrayBuffer', value.byteLength, await digest(value)];
    if (Array.isArray(value)) {
      const items = [];
      for (const item of value) items.push(await canonical(item, depth + 1));
      return items;
    }
    if (value instanceof Map) {
      const entries = [];
      for (const [key, item] of value) entries.push([await canonical(key, depth + 1), await canonical(item, depth + 1)]);
      return ['Map', entries.sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])))];
    }
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) refuse('unsupported object');
    const entries = [];
    for (const key of Object.keys(value).sort()) entries.push([key, await canonical(value[key], depth + 1)]);
    return entries;
  }
  const hash = async value => digest(encoder.encode(JSON.stringify(await canonical(value))));
  const store = globalThis.__ifc_lite_viewer_store__;
  if (!store || typeof store.getState !== 'function') refuse('viewer store unavailable');
  const state = store.getState();
  if (state.loading || state.geometryStreamingActive || state.error) refuse('global load/stream/error not settled');
  if (!(state.models instanceof Map) || state.models.size !== 1) refuse('expected exactly one loaded model');
  const model = [...state.models.values()][0];
  if (model.loadState !== 'complete' || model.loadError) refuse('model incomplete/error');
  const geometry = model.geometryResult, data = model.ifcDataStore;
  if (!geometry || !Array.isArray(geometry.meshes) || !data?.entities || !data?.properties) refuse('geometry/properties not ready');
  if (geometry.pointClouds?.length) refuse('point-cloud output unsupported');
  if (!data.entityIndex?.byType || !Number.isInteger(data.entities.count) || !Number.isInteger(data.properties.count)
    || typeof data.properties.getForEntity !== 'function') refuse('metadata/private property shape changed');
  for (const type of data.entityIndex.byType.keys()) {
    if (String(type).toUpperCase().startsWith('IFCTEXT')) refuse('authored text appearance unsupported');
  }
  const propertyOwner = data.properties.count ? data.properties.entityId[0] : null;
  const propertyWitness = propertyOwner === null ? [] : data.properties.getForEntity(propertyOwner);
  if (!Array.isArray(propertyWitness)) refuse('authored property callback shape');
  if (data.properties.count && !propertyWitness.length) refuse('authored property read unavailable');

  // React internals are inspected only now; no renderer interception during timing.
  let renderer;
  const canvas = document.querySelector('canvas');
  const fiberKey = canvas && Object.keys(canvas).find(key => key.startsWith('__reactFiber$'));
  let fiber = fiberKey && canvas[fiberKey];
  const seen = new Set();
  for (let parents = 0; fiber && parents < 200; parents++, fiber = fiber.return) {
    if (seen.has(fiber)) refuse('fiber cycle');
    seen.add(fiber);
    let hook = fiber.memoizedState;
    for (let hops = 0; hook && hops < 200; hops++, hook = hook.next) {
      const candidate = hook.memoizedState?.current;
      if (candidate && typeof candidate.getScene === 'function' && typeof candidate.isReady === 'function') {
        if (renderer && renderer !== candidate) refuse('ambiguous renderer');
        renderer = candidate;
      }
    }
  }
  if (!renderer?.isReady()) refuse('renderer unavailable/not ready');
  const scene = renderer.getScene();
  if (typeof scene.isGeometryDataReleased !== 'function' || scene.isGeometryDataReleased()) refuse('scene CPU geometry released/unknown');
  if (!(scene.instancedEntityMap instanceof Map) || !Array.isArray(scene.instancedTemplateCpu)
    || typeof scene.getAllMeshDataExpressIds !== 'function') refuse('private scene shape changed');

  const meshFields = new Set(['expressId', 'ifcType', 'modelIndex', 'positions', 'normals', 'indices', 'appearanceSource',
    'color', 'shadingColor', 'entityIds', 'geometryItemId', 'materialId', 'material', 'geometryHash', 'geometryAabb',
    'geometryVolume', 'geometryClass', 'origin', 'occurrenceKey', 'localBounds', 'localToWorld',
    'uvs', 'texture', 'textureRef', 'textureBitmap']);
  const flat = [], expectedOwners = new Set();
  let vertices = 0, triangles = 0;
  for (const mesh of geometry.meshes) {
    if (Object.keys(mesh).some(key => !meshFields.has(key))) refuse('unknown flat mesh channel');
    if (mesh.uvs || mesh.texture || mesh.textureRef || mesh.textureBitmap) refuse('UV/texture output unsupported');
    if (!(mesh.positions instanceof Float32Array) || !(mesh.normals instanceof Float32Array)
      || !(mesh.indices instanceof Uint32Array) || mesh.positions.length !== mesh.normals.length
      || !mesh.positions.length || !mesh.indices.length || mesh.positions.length % 3 || mesh.indices.length % 3
      || !Array.isArray(mesh.color) || mesh.color.length !== 4) {
      refuse('flat raw buffer shape changed');
    }
    if (mesh.material && Object.keys(mesh.material).some(key => !['metallic', 'roughness'].includes(key))) refuse('unknown flat finish');
    if (!Number.isInteger(mesh.expressId)) refuse('flat owner id');
    if ((mesh.geometryClass ?? 0) !== 2) expectedOwners.add(mesh.expressId);
    vertices += mesh.positions.length / 3; triangles += mesh.indices.length / 3;
    flat.push(await hash(mesh));
  }

  const templates = new Map(), instances = [];
  let occurrenceCount = 0;
  const templateFields = new Set(['modelIndex', 'positions', 'normals', 'indices', 'instanceData',
    'canonicalAnchors', 'canonicalMatrixTranslations', 'localMin', 'localMax']);
  const occurrenceFields = new Set(['templateIndex', 'byteOffset', 'originalColor', 'itemId', 'finishBits']);
  for (const [owner, occurrences] of scene.instancedEntityMap) {
    if (!Number.isInteger(owner) || !Array.isArray(occurrences) || !occurrences.length) refuse('instance owner census');
    expectedOwners.add(owner);
    for (const occurrence of occurrences) {
      if (Object.keys(occurrence).some(key => !occurrenceFields.has(key))) refuse('unknown occurrence channel');
      if (!Array.isArray(occurrence.originalColor) || occurrence.originalColor.length !== 4) refuse('original instance color absent');
      const template = scene.instancedTemplateCpu[occurrence.templateIndex];
      if (!template || Object.keys(template).some(key => !templateFields.has(key))) refuse('missing/unknown raw template channel');
      if (!(template.positions instanceof Float32Array) || !(template.normals instanceof Float32Array)
        || !(template.indices instanceof Uint32Array) || !(template.instanceData instanceof ArrayBuffer)
        || !(template.canonicalAnchors instanceof Float64Array) || !(template.canonicalMatrixTranslations instanceof Float32Array)
        || template.positions.length !== template.normals.length || !template.positions.length || !template.indices.length
        || template.positions.length % 3 || template.indices.length % 3
        || template.instanceData.byteLength % 88) refuse('raw instance shape/stride changed');
      const offset = occurrence.byteOffset, index = offset / 88;
      if (!Number.isInteger(index) || index < 0 || offset + 88 > template.instanceData.byteLength
        || template.canonicalAnchors.length !== template.instanceData.byteLength / 88 * 3
        || template.canonicalMatrixTranslations.length !== template.canonicalAnchors.length) refuse('incomplete raw occurrence channels');
      if (new DataView(template.instanceData).getUint32(offset + 64, true) !== owner) refuse('packed owner mismatch');
      if (!templates.has(occurrence.templateIndex)) templates.set(occurrence.templateIndex, {
        sha256: await hash({ modelIndex: template.modelIndex, positions: template.positions, normals: template.normals,
          indices: template.indices, localMin: template.localMin, localMax: template.localMax }), used: new Set(),
        expected: template.instanceData.byteLength / 88,
      });
      const entry = templates.get(occurrence.templateIndex);
      if (entry.used.has(index)) refuse('duplicate occurrence census');
      entry.used.add(index);
      instances.push(await hash({ owner, template: entry.sha256,
        packedRecord: template.instanceData.slice(offset, offset + 88),
        anchor: template.canonicalAnchors.subarray(index * 3, index * 3 + 3),
        canonicalTranslation: template.canonicalMatrixTranslations.subarray(index * 3, index * 3 + 3),
        originalColor: occurrence.originalColor, itemId: occurrence.itemId, finishBits: occurrence.finishBits }));
      occurrenceCount++;
    }
  }
  for (const entry of templates.values()) if (entry.used.size !== entry.expected) refuse('template occurrence census incomplete');
  if (scene.instancedTemplateCpu.filter(Boolean).length !== templates.size) refuse('unowned retained template');
  const actualOwners = scene.getAllMeshDataExpressIds().sort((a, b) => a - b);
  const owners = [...expectedOwners].sort((a, b) => a - b);
  if (JSON.stringify(actualOwners) !== JSON.stringify(owners)) refuse('flat/instance scene owner census mismatch');
  if (scene.getInstancedEntityCount() !== scene.instancedEntityMap.size) refuse('instance scene census changed');
  if (!flat.length && !occurrenceCount) refuse('no retained geometric output');
  const gpuTemplates = scene.getInstancedTemplates?.();
  if (!Array.isArray(gpuTemplates) || gpuTemplates.reduce((sum, template) => sum + template.instanceCount, 0) !== occurrenceCount) {
    refuse('GPU instance occurrence census incomplete');
  }

  const result = { flat: flat.sort(), instances: instances.sort(), coordinateInfo: geometry.coordinateInfo,
    totalTriangles: geometry.totalTriangles, totalVertices: geometry.totalVertices,
    instancedGeometryHashes: geometry.instancedGeometryHashes,
    instancedGeometryAabbs: geometry.instancedGeometryAabbs, instancedGeometryVolumes: geometry.instancedGeometryVolumes };
  return { complete: true, sha256: await hash(result), flatMeshes: flat.length, flatVertices: vertices,
    flatTriangles: triangles, templates: templates.size, instanceOwners: scene.instancedEntityMap.size,
    occurrences: occurrenceCount, owners: owners.length, digestBytes: bytes,
    channels: 'flat raw mesh fields excluding unsupported UV/textures; raw template positions/normals/indices; packed 88-byte matrix/owner/color/flags; f64 anchors; f32 canonical translations; original occurrence color/item/finish; coordinate info; geometry hashes/AABBs/volumes',
    model: { loadState: model.loadState, loadError: model.loadError ?? null,
      geometryLoadState: model.geometryLoadState ?? null, metadataLoadState: model.metadataLoadState ?? null,
      interactiveReady: model.interactiveReady ?? null, propertiesReady: true,
      entityCount: data.entities.count, propertyCount: data.properties.count,
      propertyWitnessOwner: propertyOwner, propertyWitness },
    renderStats: globalThis.__ifc_lite_render_stats__?.() ?? null };
}
