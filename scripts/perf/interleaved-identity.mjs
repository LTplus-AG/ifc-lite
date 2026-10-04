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
  let renderer, rendererProps, ambiguousRendererProps = false, currentFiberBranch = false;
  const canvas = document.querySelector('canvas');
  const fiberKey = canvas && Object.keys(canvas).find(key => key.startsWith('__reactFiber$'));
  let fiber = fiberKey && canvas[fiberKey];
  const seen = new Set();
  let totalHooks = 0;
  for (let parents = 0; fiber && parents < 200; parents++, fiber = fiber.return) {
    if (seen.has(fiber)) refuse('fiber cycle');
    seen.add(fiber);
    if (!Number.isSafeInteger(fiber.tag) || fiber.tag < 0 || fiber.tag > 31) refuse('unknown React fiber tag');
    if (fiber.tag === 3 && fiber.stateNode?.current === fiber) currentFiberBranch = true;
    if (![0, 11, 14, 15].includes(fiber.tag)) continue;
    let hook = fiber.memoizedState;
    const hookSeen = new Set();
    let hops = 0;
    for (; hook && hops < 2048 && totalHooks < 65536; hops++, totalHooks++, hook = hook.next) {
      if (typeof hook !== 'object' || hook === null || (hook.next !== null && typeof hook.next !== 'object')) {
        refuse('unknown Hook shape');
      }
      if (hookSeen.has(hook)) refuse('hook cycle');
      hookSeen.add(hook);
      const candidate = hook.memoizedState?.current;
      if (candidate && typeof candidate.getScene === 'function' && typeof candidate.isReady === 'function') {
        if (renderer && renderer !== candidate) refuse('ambiguous renderer');
        renderer = candidate;
        if (Array.isArray(fiber.memoizedProps?.geometry)) {
          if (rendererProps && rendererProps.geometry !== fiber.memoizedProps.geometry) ambiguousRendererProps = true;
          rendererProps = fiber.memoizedProps;
        }
      }
    }
    if (hook) refuse('hook discovery budget exhausted');
  }
  if (fiber) refuse('fiber discovery budget exhausted');
  if (!renderer?.isReady()) refuse('renderer unavailable/not ready');
  const scene = renderer.getScene();
  if (typeof scene.isGeometryDataReleased !== 'function' || scene.isGeometryDataReleased()) refuse('scene CPU geometry released/unknown');
  if (!(scene.instancedEntityMap instanceof Map) || !Array.isArray(scene.instancedTemplateCpu)
    || typeof scene.getAllMeshDataExpressIds !== 'function'
    || typeof scene.getInstancedEntityCount !== 'function') refuse('private scene shape changed');

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
  if (JSON.stringify(actualOwners) !== JSON.stringify(owners)) {
    refuse(`flat/instance scene owner census mismatch; ownerDiagnostic=${JSON.stringify(ownerRefusalDiagnostic())}`);
  }
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

  // Refusal-only, post-hash evidence. Neither population changes expectedOwners.
  // Viewport input is not a census of visible draw calls/pixels; user hides,
  // isolation, instanced suppression and clipping may act after ingestion.
  function ownerRefusalDiagnostic() {
    const bounds = { ids: 64, meshesPerPopulation: 100000, contributorReadsPerPopulation: 1000000,
      tableKeys: 32, detailIdsPerPopulation: 16, detailValuesPerField: 4, scenePiecesPerId: 16, labelChars: 64 };
    const scalar = value => typeof value === 'boolean' || Number.isSafeInteger(value) ? value : 'unavailable';
    const label = value => typeof value === 'string' ? value.slice(0, bounds.labelChars) : 'unavailable';
    const missing = [], extra = [];
    let missingCount = 0, extraCount = 0, expectedIndex = 0, actualIndex = 0;
    const integerOwners = owners.every(Number.isSafeInteger) && actualOwners.every(Number.isSafeInteger);
    if (integerOwners) {
      while (expectedIndex < owners.length || actualIndex < actualOwners.length) {
        const expected = owners[expectedIndex], actual = actualOwners[actualIndex];
        if (expectedIndex < owners.length && (actualIndex === actualOwners.length || expected < actual)) {
          missingCount++; if (missing.length < bounds.ids) missing.push(expected); expectedIndex++;
        } else if (actualIndex < actualOwners.length && (expectedIndex === owners.length || actual < expected)) {
          extraCount++; if (extra.length < bounds.ids) extra.push(actual); actualIndex++;
        } else { expectedIndex++; actualIndex++; }
      }
    }
    const interested = new Set([...missing, ...extra]);
    const bump = (map, key, summary) => {
      if (map.has(key)) map.set(key, map.get(key) + 1);
      else if (map.size < bounds.tableKeys) map.set(key, 1);
      else summary.omittedTableEntries++;
    };
    function population(meshes) {
      if (!Array.isArray(meshes)) return { available: false };
      const classes = new Map(), types = new Map(), details = new Map();
      const summary = { available: true, meshes: meshes.length, scannedMeshes: 0, complete: true,
        contributorReads: 0, mergedMeshes: 0, summedDistinctMergedContributors: 0,
        omittedTableEntries: 0, omittedDetailOccurrences: 0 };
      function detail(id, mesh, via) {
        if (!interested.has(id)) return;
        if (!details.has(id) && details.size === bounds.detailIdsPerPopulation) { summary.omittedDetailOccurrences++; return; }
        if (!details.has(id)) details.set(id, { id, representativePieces: 0, mergedContributorPieces: 0,
          classes: [], types: [], complete: true, omittedClassOccurrences: 0, omittedTypeOccurrences: 0 });
        const entry = details.get(id), meshClass = scalar(mesh.geometryClass ?? 0), type = label(mesh.ifcType);
        entry[via]++;
        function value(field, item, omitted) {
          if (entry[field].includes(item)) return;
          if (entry[field].length < bounds.detailValuesPerField) entry[field].push(item);
          else { entry[omitted]++; entry.complete = false; }
        }
        value('classes', meshClass, 'omittedClassOccurrences');
        value('types', type, 'omittedTypeOccurrences');
      }
      for (let index = 0; index < Math.min(meshes.length, bounds.meshesPerPopulation); index++) {
        const mesh = meshes[index];
        if (!mesh || typeof mesh !== 'object') { summary.complete = false; break; }
        summary.scannedMeshes++;
        bump(classes, scalar(mesh.geometryClass ?? 0), summary); bump(types, label(mesh.ifcType), summary);
        detail(mesh.expressId, mesh, 'representativePieces');
        if (mesh.entityIds?.length) {
          summary.mergedMeshes++;
          if (!(mesh.entityIds instanceof Uint32Array)) { summary.complete = false; continue; }
          const contributors = new Set();
          for (let offset = 0; offset < mesh.entityIds.length; offset++) {
            if (summary.contributorReads === bounds.contributorReadsPerPopulation) { summary.complete = false; break; }
            summary.contributorReads++;
            const id = mesh.entityIds[offset];
            if (!contributors.has(id)) { contributors.add(id); detail(id, mesh, 'mergedContributorPieces'); }
          }
          summary.summedDistinctMergedContributors += contributors.size;
        }
      }
      summary.complete = summary.complete && summary.scannedMeshes === meshes.length && !summary.omittedTableEntries
        && !summary.omittedDetailOccurrences
        && [...details.values()].every(entry => entry.complete);
      return { ...summary, classes: [...classes], types: [...types], mismatchIdDetails: [...details.values()] };
    }
    const idSet = value => {
      if (value === null) return { available: true, isNull: true };
      if (!(value instanceof Set)) return { available: false };
      const ids = [];
      for (const id of value) { if (ids.length === bounds.ids) break; ids.push(scalar(id)); }
      return { available: true, count: value.size, sample: ids, complete: value.size <= bounds.ids };
    };
    const typeVisibility = {};
    for (const key of ['spaces', 'spatialZones', 'openings', 'virtualElements', 'site', 'ifcAnnotations', 'ifcGrid']) {
      typeVisibility[key] = scalar(state.typeVisibility?.[key]);
    }
    const observedProps = currentFiberBranch && !ambiguousRendererProps ? rendererProps : undefined;
    const sceneOwnerDetails = [];
    if (scene.meshDataMap instanceof Map) {
      for (const id of [...interested].slice(0, bounds.detailIdsPerPopulation)) {
        const pieces = scene.meshDataMap.get(id), occurrences = scene.instancedEntityMap.get(id);
        const rows = Array.isArray(pieces) ? pieces.slice(0, bounds.scenePiecesPerId) : [];
        const validRows = rows.filter(mesh => mesh && typeof mesh === 'object');
        sceneOwnerDetails.push({ id, flatPieces: pieces === undefined ? 0 : Array.isArray(pieces) ? pieces.length : 'unavailable',
          instanceOccurrences: occurrences === undefined ? 0 : Array.isArray(occurrences) ? occurrences.length : 'unavailable',
          scannedPieces: rows.length, complete: (pieces === undefined || Array.isArray(pieces))
            && rows.length === (pieces?.length ?? 0) && validRows.length === rows.length,
          mergedPiecesObserved: validRows.filter(mesh => mesh.entityIds?.length).length,
          classes: [...new Set(validRows.map(mesh => scalar(mesh.geometryClass ?? 0)))],
          types: [...new Set(validRows.map(mesh => label(mesh.ifcType)))] });
      }
    }
    return { version: 1, bounds, expectedOwners: owners.length, actualOwners: actualOwners.length,
      differenceAvailable: integerOwners, missingCount: integerOwners ? missingCount : null,
      extraCount: integerOwners ? extraCount : null, missing, extra,
      samplesComplete: integerOwners && missingCount <= bounds.ids && extraCount <= bounds.ids,
      policy: { requestedTypeViewMode: label(state.typeViewMode), effectiveViewMode: 'not directly observed',
        typeVisibility, modelVisible: scalar(model.visible),
        hiddenEntities: idSet(state.hiddenEntities), isolatedEntities: idSet(state.isolatedEntities),
        ghostExceptEntities: idSet(state.ghostExceptEntities),
        computedIsolatedIds: idSet(observedProps?.computedIsolatedIds),
        geometryVersion: scalar(observedProps?.geometryVersion),
        geometryContentVersion: scalar(observedProps?.geometryContentVersion),
        instancedVisible: scalar(scene.instancedVisible) },
      producedUnfiltered: population(geometry.meshes),
      viewportInput: population(observedProps?.geometry),
      sceneOwnerDetailsAvailable: scene.meshDataMap instanceof Map, sceneOwnerDetails,
      viewportInputSource: ambiguousRendererProps ? 'ambiguous renderer-owning Fiber geometry props'
        : !currentFiberBranch ? 'current FiberRoot branch not verified'
          : rendererProps ? 'current renderer-owning Fiber memoizedProps.geometry' : 'unavailable',
      scope: 'owner refusal evidence only; no visibility causation or rendered-pixel identity' };
  }
}
