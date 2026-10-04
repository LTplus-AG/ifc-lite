/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A separate prospective protocol. Old captureIdentity/refusals stay intact.
// All cloning, canonical serialization and hashing occurs AFTER the timer.
export async function captureViewerInputIdentity(limits) {
  const refuse = reason => { throw new Error(`REFUSE input identity: ${reason}`); };
  for (const key of ['oneBufferBytes', 'digestBytes', 'records']) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] <= 0) refuse('invalid post-timer bounds');
  }
  if (typeof limits.zeroPlacementSource !== 'string') refuse('frozen zero-placement oracle absent');
  const expectedZeroPlacement = Function(`"use strict"; return (${limits.zeroPlacementSource});`)();
  const witness = globalThis.__ifc_lite_input_witness__;
  if (!witness) refuse('before-load witness absent');
  const frozen = witness.freeze(), observed = witness.validate(frozen.revision);
  const state = witness.store.getState(), model = state.models.get(frozen.modelId);
  const geometry = model?.geometryResult, data = model?.ifcDataStore, { scene, props, renderer } = observed;
  if (state.loading || state.geometryStreamingActive || state.error || model?.loadState !== 'complete'
    || model.loadError || !geometry || !Array.isArray(geometry.meshes) || !Array.isArray(props.geometry)
    || !renderer.isReady() || !data?.entities || !data?.properties) refuse('not complete current model/viewport');
  if (model.visible !== true || (model.idOffset ?? 0) !== 0 || props.cesiumActive || props.releaseGeometryAfterStream) refuse('noncanonical primary viewport scope');
  if (geometry.pointClouds?.length || props.pointClouds?.length) refuse('point clouds unsupported');
  if (!data.entityIndex?.byType || !Number.isInteger(data.entities.count) || !Number.isInteger(data.properties.count)
    || typeof data.properties.getForEntity !== 'function') refuse('metadata/property shape changed');
  for (const type of data.entityIndex.byType.keys()) if (String(type).toUpperCase().startsWith('IFCTEXT')) refuse('authored text appearance unsupported');
  if (state.pendingInstancedShards?.length || scene.isGeometryDataReleased?.() !== false
    || scene.hasQueuedMeshes?.() !== false || scene.hasStreamingFragments?.() !== false
    || scene.hasPendingBatches?.() !== false || scene.isFinalizeInProgress?.() !== false) refuse('scene not retained/settled');
  if (!(scene.instancedEntityMap instanceof Map) || !Array.isArray(scene.instancedTemplateCpu)
    || typeof scene.getAllMeshDataExpressIds !== 'function' || typeof scene.getInstancedEntityCount !== 'function') refuse('unknown Scene shape');
  if (scene.instanceSuppression?.retained !== false || scene.instancedHidden?.size !== 0
    || scene.instancedSelected?.size !== 0 || scene.instancedOverridden?.size !== 0 || scene.instancedGhosted?.size !== 0) refuse('instance appearance mutation unsupported');
  const translation = scene.getModelTranslation?.(0), rotation = scene.getModelRotation?.(0);
  if (!Array.isArray(translation) || translation.length !== 3 || translation.some(value => value !== 0) || rotation !== null) refuse('model placement unsupported');
  const visibility = state.typeVisibility;
  const visibilityKeys = ['spaces', 'spatialZones', 'openings', 'virtualElements', 'site', 'ifcAnnotations', 'ifcGrid'];
  if (!visibility || Object.keys(visibility).length !== visibilityKeys.length
    || visibilityKeys.some(key => typeof visibility[key] !== 'boolean') || !['model', 'types'].includes(state.typeViewMode)
    || typeof state.hasTypeGeometry !== 'boolean' || typeof scene.instancedVisible !== 'boolean') refuse('visibility policy shape');
  function ids(value, field, nullable = true) {
    if (value === null && nullable) return null;
    if (!(value instanceof Set) || [...value].some(id => !Number.isSafeInteger(id))) refuse(`unknown ${field}`);
    return [...value].sort((a, b) => a - b);
  }
  const policy = { typeVisibility: visibility, requestedTypeViewMode: state.typeViewMode,
    hasTypeGeometry: state.hasTypeGeometry, effectiveViewMode: state.hasTypeGeometry ? state.typeViewMode : 'model',
    effectiveViewModeSource: 'derived from frozen ViewportContainer rule; actual input independently hashed',
    modelVisible: model.visible, hiddenEntities: ids(state.hiddenEntities, 'hiddenEntities', false),
    isolatedEntities: ids(state.isolatedEntities, 'isolatedEntities'), ghostExceptEntities: ids(state.ghostExceptEntities, 'ghostExceptEntities'),
    computedIsolatedIds: ids(props.computedIsolatedIds, 'computedIsolatedIds'), instancedVisible: scene.instancedVisible };
  // First-file/default presentation only. Hidden type toggles are supported;
  // user isolation/hide/ghost overlays are explicitly not silently modeled.
  if (policy.hiddenEntities.length || policy.isolatedEntities !== null || policy.ghostExceptEntities !== null
    || policy.computedIsolatedIds !== null || !policy.instancedVisible || policy.effectiveViewMode !== 'model') refuse('nondefault presentation unsupported');
  if (!(props.modelIdToIndex instanceof Map) || props.modelIdToIndex.size !== 1
    || props.modelIdToIndex.get(frozen.modelId) !== 0) refuse('current model-to-index ownership unavailable');
  const propertyOwner = data.properties.count ? data.properties.entityId[0] : null;
  const propertyWitness = propertyOwner === null ? [] : data.properties.getForEntity(propertyOwner);
  if (!Array.isArray(propertyWitness) || (data.properties.count && !propertyWitness.length)) refuse('authored property read unavailable');

  const encoder = new TextEncoder(); let digestBytes = 0, records = 0;
  async function digest(value) {
    if (value.byteLength > limits.oneBufferBytes || (digestBytes += value.byteLength) > limits.digestBytes) refuse('digest byte bound');
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function canonical(value, depth = 0) {
    if (depth > 24 || ++records > limits.records) refuse('canonical work bound');
    if (value === undefined) return ['absent'];
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return ['bigint', value.toString()];
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) refuse('nonfinite scalar');
      return Object.is(value, -0) ? ['negative-zero'] : value;
    }
    if (ArrayBuffer.isView(value)) {
      if (value.byteLength > limits.oneBufferBytes) refuse('one buffer exceeds snapshot bound');
      const copy = new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).buffer;
      return [value.constructor.name, value.byteLength, await digest(copy)];
    }
    if (value instanceof ArrayBuffer) {
      if (value.byteLength > limits.oneBufferBytes) refuse('one buffer exceeds snapshot bound');
      return ['ArrayBuffer', value.byteLength, await digest(value.slice(0))];
    }
    if (Array.isArray(value)) {
      const items = []; for (const item of value) items.push(await canonical(item, depth + 1)); return items;
    }
    if (value instanceof Map) {
      const entries = []; for (const [key, item] of value) entries.push([await canonical(key, depth + 1), await canonical(item, depth + 1)]);
      return ['Map', entries.sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])))];
    }
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) refuse('unsupported raw object');
    const items = []; for (const key of Object.keys(value).sort()) items.push([key, await canonical(value[key], depth + 1)]); return items;
  }
  const hash = async value => digest(encoder.encode(JSON.stringify(await canonical(value))));
  const fields = new Set(['expressId', 'ifcType', 'modelIndex', 'positions', 'normals', 'indices', 'appearanceSource',
    'color', 'shadingColor', 'entityIds', 'geometryItemId', 'materialId', 'material', 'geometryHash', 'geometryAabb',
    'geometryVolume', 'geometryClass', 'origin', 'occurrenceKey', 'localBounds', 'localToWorld',
    'uvs', 'texture', 'textureRef', 'textureBitmap']);
  function validateMesh(mesh) {
    if (!mesh || Object.keys(mesh).some(key => !fields.has(key))) refuse('unknown flat mesh channel');
    if (mesh.uvs || mesh.texture || mesh.textureRef || mesh.textureBitmap) refuse('UV/texture output unsupported');
    if (!(mesh.positions instanceof Float32Array) || !(mesh.normals instanceof Float32Array)
      || !(mesh.indices instanceof Uint32Array) || mesh.positions.length !== mesh.normals.length
      || !mesh.positions.length || !mesh.indices.length || mesh.positions.length % 3 || mesh.indices.length % 3
      || !Array.isArray(mesh.color) || mesh.color.length !== 4 || !Number.isSafeInteger(mesh.expressId)) refuse('flat raw shape');
    if (mesh.material && Object.keys(mesh.material).some(key => !['metallic', 'roughness'].includes(key))) refuse('unknown finish');
    if (!mesh.color.every(Number.isFinite) || (mesh.modelIndex !== undefined && mesh.modelIndex !== 0)) refuse('nonfinite/nonprimary flat input');
    if (mesh.entityIds !== undefined && (!(mesh.entityIds instanceof Uint32Array) || mesh.entityIds.length !== mesh.positions.length / 3)) refuse('merged contributor shape');
  }
  const flat = [], viewport = [], expectedOwners = new Set(), templateInputs = new Map(), expectedInstances = new Map();
  const expectedFlatPieces = new Map(), actualFlatPieces = new Map(), placedHashes = new WeakMap(), retainedHashes = new WeakMap();
  for (const mesh of geometry.meshes) { validateMesh(mesh); flat.push(await hash(mesh)); }
  for (const mesh of props.geometry) {
    validateMesh(mesh); viewport.push(await hash(mesh));
    if (!placedHashes.has(mesh)) placedHashes.set(mesh, await hash(expectedZeroPlacement(mesh)));
    const contributors = mesh.entityIds?.length ? new Set(mesh.entityIds) : new Set([mesh.expressId]);
    for (const id of contributors) {
      expectedOwners.add(id);
      const pieces = expectedFlatPieces.get(id) ?? []; pieces.push(placedHashes.get(mesh)); expectedFlatPieces.set(id, pieces);
    }
  }
  // Read retained flat pieces directly: getMeshDataPieces extracts contributors,
  // while forEachMeshData also materializes instances. Neither is this census.
  if (!(scene.meshDataMap instanceof Map)) refuse('retained flat piece map unavailable');
  for (const [owner, pieces] of scene.meshDataMap) {
    if (!Number.isSafeInteger(owner) || !Array.isArray(pieces) || !pieces.length) refuse('retained flat piece shape');
    const hashes = [];
    for (const piece of pieces) {
      validateMesh(piece);
      if (!retainedHashes.has(piece)) retainedHashes.set(piece, await hash(piece));
      hashes.push(retainedHashes.get(piece));
    }
    actualFlatPieces.set(owner, hashes.sort());
  }
  for (const pieces of expectedFlatPieces.values()) pieces.sort();
  if (await hash(expectedFlatPieces) !== await hash(actualFlatPieces)) refuse('independent retained flat piece multiset mismatch');
  const rawInputs = [], decodedInputs = [], decodedShardProvenance = [];
  const shardFields = new Set(['templates', 'instances', 'carriesItemIds', 'carriesFinishes']);
  const templateFields = new Set(['positions', 'normals', 'indices', 'origin']);
  const instanceFields = new Set(['templateIndex', 'entityId', 'color', 'transform', 'itemId', 'metallic', 'roughness']);
  // Coverage/admission only: do not create a second IFNS geometry decoder.
  // Actual decoded channels still come from canonical native method arguments.
  // This restricts the permissive decoder to the frozen encoder's known forms.
  function envelope(input) {
    const { buffer } = input.delivery;
    if (buffer.byteLength < 32) refuse('raw wire header truncated');
    const header = new Uint32Array(buffer, 0, 8);
    const [magic, version, templateCount, instanceCount, posCount, normCount, idxCount, declared] = header;
    const stride = version === 1 && declared === 0 ? 88 : version === 2 && declared === 92 ? 92 : version === 3 && declared === 100 ? 100 : null;
    const { shard } = input;
    if (magic !== 0x49464e53 || stride === null || templateCount !== shard.templates.length
      || instanceCount !== shard.instances.length || shard.carriesItemIds !== (stride >= 92)
      || shard.carriesFinishes !== (stride === 100)) refuse('unknown/mismatched raw wire envelope');
    const dataOffset = 32 + templateCount * 48 + instanceCount * stride;
    if (!Number.isSafeInteger(dataOffset) || dataOffset + (posCount + normCount + idxCount) * 4 !== buffer.byteLength) refuse('unknown raw wire tail/extent');
    let pos = 0, norm = 0, idx = 0;
    const raw = new DataView(buffer);
    for (const [index, template] of shard.templates.entries()) {
      const base = 32 + index * 48;
      if (!template || !(template.positions instanceof Float32Array) || !(template.normals instanceof Float32Array)
        || !(template.indices instanceof Uint32Array)) refuse('unknown template pool input shape');
      if (raw.getUint32(base, true) !== pos || raw.getUint32(base + 4, true) !== template.positions.length
        || raw.getUint32(base + 8, true) !== norm || raw.getUint32(base + 12, true) !== template.normals.length
        || raw.getUint32(base + 16, true) !== idx || raw.getUint32(base + 20, true) !== template.indices.length
        || template.positions.byteOffset !== dataOffset + pos * 4
        || template.normals.byteOffset !== dataOffset + (posCount + norm) * 4
        || template.indices.byteOffset !== dataOffset + (posCount + normCount + idx) * 4) refuse('uncovered/replaced template pool input');
      pos += template.positions.length; norm += template.normals.length; idx += template.indices.length;
    }
    if (pos !== posCount || norm !== normCount || idx !== idxCount) refuse('uncovered template pool bytes');
    return { version, stride, byteLength: buffer.byteLength, templates: templateCount, occurrences: instanceCount };
  }
  for (const delivery of frozen.deliveries) {
    if (delivery.modelId !== frozen.modelId || delivery.buffer.byteLength !== delivery.byteLength || delivery.ingestions !== 1) refuse('delivery ownership/size changed');
    rawInputs.push({ delivery: rawInputs.length, byteLength: delivery.byteLength, sha256: await hash(delivery.buffer) });
  }
  for (const input of frozen.inputs) {
    const shard = input.shard;
    if (!input.accepted || input.templates !== shard.templates || input.instances !== shard.instances
      || input.modelIndex !== 0 || input.device !== frozen.device || Object.keys(shard).some(key => !shardFields.has(key))
      || typeof shard.carriesItemIds !== 'boolean' || typeof shard.carriesFinishes !== 'boolean') refuse('decoded input shape/lifecycle changed');
    const wireEnvelope = envelope(input);
    const counts = new Map(), logicalTemplates = new Map();
    for (const instance of shard.instances) {
      if (!instance || Object.keys(instance).some(key => !instanceFields.has(key)) || !Number.isSafeInteger(instance.entityId)
        || instance.entityId <= 0 || !Number.isSafeInteger(instance.templateIndex)
        || instance.templateIndex < 0 || instance.templateIndex >= shard.templates.length
        || !(instance.transform instanceof Float32Array) || instance.transform.length !== 16
        || !Array.isArray(instance.color) || instance.color.length !== 4) refuse('malformed instance input');
      if (instance.entityId > 0xffffffff || (instance.itemId !== undefined && (!Number.isSafeInteger(instance.itemId)
        || instance.itemId <= 0 || instance.itemId > 0xffffffff || !shard.carriesItemIds))
        || ['metallic', 'roughness'].some(field => instance[field] !== undefined && (!Number.isFinite(instance[field]) || !shard.carriesFinishes))) refuse('instance scalar channel shape');
      // Do not duplicate permissive renderer admission: this prototype accepts
      // only normal opaque input; preserves every raw delivery before refusal.
      if (!instance.color.every(Number.isFinite) || instance.color[3] !== 1
        || !instance.transform.every(Number.isFinite)) refuse('not fully opaque/finite instance input unsupported');
      counts.set(instance.templateIndex, (counts.get(instance.templateIndex) ?? 0) + 1);
      expectedOwners.add(instance.entityId);
      expectedInstances.set(instance.entityId, (expectedInstances.get(instance.entityId) ?? 0) + 1);
    }
    for (const [index, template] of shard.templates.entries()) {
      if (!template || Object.keys(template).some(key => !templateFields.has(key))
        || !(template.positions instanceof Float32Array) || !(template.normals instanceof Float32Array)
        || !(template.indices instanceof Uint32Array) || !template.positions.length || !template.indices.length
        || template.positions.length !== template.normals.length || template.positions.length % 3 || template.indices.length % 3
        || !template.positions.every(Number.isFinite) || !template.normals.every(Number.isFinite)
        || !template.indices.every(value => value < template.positions.length / 3)
        || !Array.isArray(template.origin) || template.origin.length !== 3 || !template.origin.every(Number.isFinite)
        || !counts.has(index) || [template.positions, template.normals, template.indices].some(view => view.buffer !== input.delivery.buffer)) refuse('empty/malformed/unowned template input unsupported');
      const key = await hash({ positions: template.positions, normals: template.normals, indices: template.indices });
      templateInputs.set(key, (templateInputs.get(key) ?? 0) + counts.get(index));
      logicalTemplates.set(index, await hash(template));
    }
    // Bind template references to complete template content. Grouping/order and
    // template table ordinals are transport/container structure, not identity.
    // Every known per-occurrence field remains; unknown fields already refused.
    for (const instance of shard.instances) decodedInputs.push(await hash({
      templateSha256: logicalTemplates.get(instance.templateIndex), entityId: instance.entityId,
      color: instance.color, transform: instance.transform, itemId: instance.itemId,
      metallic: instance.metallic, roughness: instance.roughness,
    }));
    decodedShardProvenance.push({ delivery: frozen.deliveries.indexOf(input.delivery),
      templates: shard.templates.length, occurrences: shard.instances.length,
      carriesItemIds: shard.carriesItemIds, carriesFinishes: shard.carriesFinishes, wireEnvelope,
      association: input.empty ? 'Canonical no-output delivery/call multiplicity; no template-buffer pointer' : 'Original template-buffer pointer' });
  }
  const templates = new Map(), instances = [], actualInstanceCounts = new Map(), actualTemplateCounts = new Map();
  let occurrences = 0;
  const retainedFields = new Set(['modelIndex', 'positions', 'normals', 'indices', 'instanceData',
    'canonicalAnchors', 'canonicalMatrixTranslations', 'localMin', 'localMax']);
  const occurrenceFields = new Set(['templateIndex', 'byteOffset', 'originalColor', 'itemId', 'finishBits']);
  for (const [owner, entries] of scene.instancedEntityMap) {
    if (!Number.isSafeInteger(owner) || !Array.isArray(entries) || !entries.length) refuse('retained instance owner shape');
    actualInstanceCounts.set(owner, entries.length);
    for (const occurrence of entries) {
      if (Object.keys(occurrence).some(key => !occurrenceFields.has(key))
        || !Array.isArray(occurrence.originalColor) || occurrence.originalColor.length !== 4) refuse('retained occurrence channels');
      const template = scene.instancedTemplateCpu[occurrence.templateIndex];
      if (!template || Object.keys(template).some(key => !retainedFields.has(key)) || template.modelIndex !== 0
        || !(template.positions instanceof Float32Array) || !(template.normals instanceof Float32Array)
        || !(template.indices instanceof Uint32Array) || !(template.instanceData instanceof ArrayBuffer)
        || !(template.canonicalAnchors instanceof Float64Array) || !(template.canonicalMatrixTranslations instanceof Float32Array)
        || template.instanceData.byteLength % 88 || template.canonicalAnchors.length !== template.instanceData.byteLength / 88 * 3
        || template.canonicalMatrixTranslations.length !== template.canonicalAnchors.length) refuse('retained template shape');
      const offset = occurrence.byteOffset, index = offset / 88;
      if (!Number.isSafeInteger(index) || index < 0 || offset + 88 > template.instanceData.byteLength
        || new DataView(template.instanceData).getUint32(offset + 64, true) !== owner) refuse('retained packed owner/offset');
      if (!templates.has(occurrence.templateIndex)) {
        const key = await hash({ positions: template.positions, normals: template.normals, indices: template.indices });
        actualTemplateCounts.set(key, (actualTemplateCounts.get(key) ?? 0) + template.instanceData.byteLength / 88);
        templates.set(occurrence.templateIndex, { used: new Set(), expected: template.instanceData.byteLength / 88,
          sha256: await hash({ modelIndex: template.modelIndex, positions: template.positions, normals: template.normals,
            indices: template.indices, localMin: template.localMin, localMax: template.localMax }) });
      }
      const entry = templates.get(occurrence.templateIndex);
      if (entry.used.has(index)) refuse('duplicate retained occurrence'); entry.used.add(index);
      instances.push(await hash({ owner, template: entry.sha256, packedRecord: template.instanceData.slice(offset, offset + 88),
        anchor: template.canonicalAnchors.subarray(index * 3, index * 3 + 3),
        canonicalTranslation: template.canonicalMatrixTranslations.subarray(index * 3, index * 3 + 3),
        originalColor: occurrence.originalColor, itemId: occurrence.itemId, finishBits: occurrence.finishBits }));
      occurrences++;
    }
  }
  for (const item of templates.values()) if (item.used.size !== item.expected) refuse('incomplete retained occurrence coverage');
  if (scene.instancedTemplateCpu.filter(Boolean).length !== templates.size || scene.getInstancedEntityCount() !== expectedInstances.size) refuse('extra/missing retained template/owner');
  if (!flat.length && !occurrences) refuse('no retained geometric output');
  if (await hash(expectedInstances) !== await hash(actualInstanceCounts) || await hash(templateInputs) !== await hash(actualTemplateCounts)) refuse('independent instance input census mismatch');
  const actualOwners = scene.getAllMeshDataExpressIds().sort((a, b) => a - b), owners = [...expectedOwners].sort((a, b) => a - b);
  if (actualOwners.some(id => !Number.isSafeInteger(id)) || JSON.stringify(actualOwners) !== JSON.stringify(owners)) refuse('independent viewport/instance scene owner census mismatch');
  const gpuTemplates = scene.getInstancedTemplates?.();
  if (!Array.isArray(gpuTemplates) || gpuTemplates.reduce((count, template) => count + template.instanceCount, 0) !== occurrences) refuse('GPU occurrence census incomplete');
  // Same covered full-produced digest formula as the legacy protocol. Hidden
  // produced flat meshes are still hashed; expectation uses independent input.
  const produced = { flat: flat.sort(), instances: instances.sort(), coordinateInfo: geometry.coordinateInfo,
    totalTriangles: geometry.totalTriangles, totalVertices: geometry.totalVertices,
    instancedGeometryHashes: geometry.instancedGeometryHashes, instancedGeometryAabbs: geometry.instancedGeometryAabbs,
    instancedGeometryVolumes: geometry.instancedGeometryVolumes };
  const result = { complete: true, protocol: 'independent-viewer-input-v4-metadata-lineage-instrumented',
    producedSha256: await hash(produced), rawInstancedInputSha256: await hash(rawInputs),
    viewportInputSha256: await hash({ flat: viewport.sort(), instances: decodedInputs.sort(), policy,
      coordinateInfo: props.coordinateInfo, sectionCoordinateInfo: props.sectionCoordinateInfo, primaryModelIndex: 0 }),
    flatMeshes: flat.length, viewportMeshes: viewport.length, instanceOwners: expectedInstances.size,
    occurrences, owners: owners.length, policy, digestBytes, referenceAudit: witness.referenceAudit,
    rawInstancedInputs: rawInputs, decodedShardProvenance,
    properties: { entityCount: data.entities.count, propertyCount: data.properties.count, propertyOwner, propertyWitness } };
  const final = witness.validate(frozen.revision);
  if (final.props !== props || final.props.geometry !== props.geometry || model.geometryResult !== geometry
    || witness.store.getState() !== state) refuse('model/current input/state changed during hash');
  return result;
}
