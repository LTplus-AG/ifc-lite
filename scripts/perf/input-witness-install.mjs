/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Instrumented cold-load observer. Subscribe before the lazy Viewport exists;
// attach at the canonical debug-hook assignment before initialized ingestion.
// discoverySource is the exact frozen discoverViewerInput function, not input
// from a model. No await, serialization, digest, or geometry cloning in wrappers.
export function installViewerInputWitness({ discoverySource, bounds, referenceAudit }) {
  const refuse = reason => { throw new Error(`REFUSE input witness: ${reason}`); };
  if (globalThis.__ifc_lite_input_witness__) refuse('witness already registered');
  if (!referenceAudit?.immutableArguments || typeof referenceAudit.subjectHead !== 'string'
    || !/^[0-9a-f]{40}$/.test(referenceAudit.subjectHead) || typeof referenceAudit.manifestSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(referenceAudit.manifestSha256)) refuse('frozen reference immutability audit absent');
  for (const name of ['deliveries', 'retainedBytes', 'calls']) {
    if (!Number.isSafeInteger(bounds?.[name]) || bounds[name] <= 0) refuse('invalid witness bounds');
  }
  const discover = Function(`"use strict"; return (${discoverySource});`)();
  const store = globalThis.__ifc_lite_viewer_store__;
  if (!store || typeof store.getState !== 'function' || typeof store.subscribe !== 'function') refuse('store subscription unavailable');
  const state = store.getState();
  if (!(state.models instanceof Map) || state.models.size || state.loading || state.geometryStreamingActive
    || state.pendingInstancedShards?.length) refuse('not fresh empty viewer');
  const hookName = '__ifc_lite_render_stats__';
  const hookDescriptor = Object.getOwnPropertyDescriptor(globalThis, hookName);
  if (hookDescriptor && (!Object.hasOwn(hookDescriptor, 'value')
    || !hookDescriptor.configurable || !hookDescriptor.writable)) refuse('unexpected debug-hook descriptor');
  if (!hookDescriptor && hookName in globalThis) refuse('inherited debug hook unsupported');
  if (hookDescriptor?.value !== undefined && typeof hookDescriptor.value !== 'function') refuse('unexpected debug-hook value');
  let hookValue = hookDescriptor?.value, hookAssignments = 0, hookInstalled = false;
  let renderer, scene, attached = false;
  function requireEmptyScene() {
    if (typeof scene.addInstancedShard !== 'function' || typeof scene.getAllMeshDataExpressIds !== 'function'
    || scene.getAllMeshDataExpressIds().length || !(scene.instancedEntityMap instanceof Map)
    || scene.instancedEntityMap.size || !Array.isArray(scene.instancedTemplateCpu) || scene.instancedTemplateCpu.length) refuse('not empty canonical Scene');
  }
  const deliveries = [], inputs = [], seenEntries = new WeakSet(), byBuffer = new Map(), restorations = [];
  let failure = null, revision = 0, frozen = false, disposed = false, retainedBytes = 0, calls = 0;
  let modelId = null, model, dataStore, device;
  function fail(reason) { failure ??= reason; }
  function observe(next) {
    try {
      if (disposed) return;
      if (frozen) { revision++; fail('store update after freeze'); }
      if (!(next.models instanceof Map) || next.models.size > 1) { fail('model population changed'); return; }
      if (!(next.appliedEntityLevelOffsets instanceof Map) || next.appliedEntityLevelOffsets.size) fail('exploded placement unsupported');
      if (next.models.size) {
        const [id, item] = next.models.entries().next().value;
        if ((item.idOffset ?? 0) !== 0 || item.visible !== true) fail('nonprimary/hidden model scope');
        if (modelId !== null && (id !== modelId || (dataStore && item.ifcDataStore && item.ifcDataStore !== dataStore))) fail('model/store replaced');
        modelId = id; model = item;
        if (item.ifcDataStore) dataStore ??= item.ifcDataStore;
      } else if (modelId !== null) fail('model removed');
      const pending = next.pendingInstancedShards;
      if (pending === null || pending === undefined) return;
      if (!Array.isArray(pending) || pending.length > bounds.deliveries) { fail('pending shard shape/cap'); return; }
      for (const entry of pending) {
        if (!entry || typeof entry !== 'object') { fail('delivery shape'); continue; }
        if (seenEntries.has(entry)) continue;
        seenEntries.add(entry); revision++;
        if (frozen) { fail('delivery after freeze'); continue; }
        if (typeof entry.modelId !== 'string' || !(entry.bytes instanceof ArrayBuffer) || !entry.bytes.byteLength) { fail('delivery fields'); continue; }
        if (modelId !== null && entry.modelId !== modelId) { fail('delivery model mismatch'); continue; }
        if (byBuffer.has(entry.bytes)) { fail('same source shard delivered again'); continue; }
        retainedBytes += entry.bytes.byteLength;
        if (deliveries.length >= bounds.deliveries || retainedBytes > bounds.retainedBytes) { fail('retained input cap'); continue; }
        const record = { modelId: entry.modelId, buffer: entry.bytes, byteLength: entry.bytes.byteLength, ingestions: 0 };
        deliveries.push(record); byBuffer.set(entry.bytes, record);
      }
    } catch (error) { fail(`subscription observation failed: ${String(error).slice(0, 512)}`); }
  }
  function wrap(name, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(scene, name);
    const original = scene[name];
    if (typeof original !== 'function') refuse(`canonical method absent: ${name}`);
    const installed = replacement(original);
    Object.defineProperty(scene, name, { configurable: true, writable: true, value: installed });
    restorations.push({ name, descriptor, installed });
  }
  function attach(requireFreshGeometry = false) {
    if (disposed || frozen || attached) refuse('late/repeated renderer attachment');
    const initial = discover();
    if (requireFreshGeometry && initial.props.geometry?.length) refuse('not fresh empty viewer');
    renderer = initial.renderer; scene = initial.scene;
    requireEmptyScene();
    wrap('addInstancedShard', original => function (...args) {
      let record;
      try {
        revision++; calls++;
        if (frozen || disposed || calls > bounds.calls) fail('late/capped instance ingestion');
        const [incomingDevice, shard, index = 0] = args;
        if (this !== scene || index !== 0 || !shard || !Array.isArray(shard.templates)
          || !Array.isArray(shard.instances) || shard.templates.length > bounds.calls) fail('instance ingress ownership/shape');
        if (device && incomingDevice !== device) fail('GPU device replaced');
        device ??= incomingDevice;
        if (!failure) {
          if (!shard.templates.length || !shard.instances.length) fail('empty decoded shard unsupported');
          const buffer = shard.templates[0]?.positions?.buffer, delivery = byBuffer.get(buffer);
          if (!delivery || shard.templates.some(t => t.positions?.buffer !== buffer || t.normals?.buffer !== buffer || t.indices?.buffer !== buffer)) fail('decoded shard not linked to original delivery');
          else if (delivery.ingestions++) fail('source shard ingested twice');
          else {
            record = { shard, templates: shard.templates, instances: shard.instances, delivery, device: incomingDevice, modelIndex: index, accepted: false };
            inputs.push(record);
          }
        }
      } catch (error) { fail(`ingress observation failed: ${String(error).slice(0, 512)}`); }
      // Always delegate, including observer refusal, and preserve native throw.
      try {
        const result = Reflect.apply(original, this, args);
        if (record) record.accepted = true;
        return result;
      } catch (error) { fail('native instance ingestion threw'); throw error; }
    });
    // These mutate/remove canonical cold-load inputs. Ordinary flat rebuilds
    // are not intercepted: their expectation is the final current input.
    for (const name of ['removeMeshesForEntity', 'removeMeshesForEntities', 'removeInstancedTemplatesForModel',
      'translateMeshesForEntity', 'rotateMeshesForEntity', 'retainInstancedOccurrence', 'releaseGeometryData']) {
      wrap(name, original => function (...args) {
        revision++; fail(`unsupported canonical mutation: ${name}`);
        return Reflect.apply(original, this, args);
      });
    }
    wrap('clear', original => function (...args) {
      revision++;
      if (inputs.length || deliveries.length || frozen) fail('Scene reset after input delivery');
      return Reflect.apply(original, this, args);
    });
    attached = true;
  }
  function restoreMethods() {
    for (const { name, descriptor, installed } of restorations.reverse()) {
      if (scene[name] !== installed) { fail(`witness method replaced: ${name}`); continue; }
      if (descriptor) Object.defineProperty(scene, name, descriptor); else delete scene[name];
    }
    restorations.length = 0;
  }
  function verifyHook() {
    const current = Object.getOwnPropertyDescriptor(globalThis, hookName);
    if (!current || current.get !== hookAccess.get || current.set !== hookAccess.set) refuse('debug hook deleted/replaced');
  }
  function restoreHook() {
    if (!hookInstalled) return;
    const current = Object.getOwnPropertyDescriptor(globalThis, hookName);
    if (!current || current.get !== hookAccess.get || current.set !== hookAccess.set) {
      fail('debug hook deleted/replaced'); return;
    }
    if (hookAssignments) Object.defineProperty(globalThis, hookName, { configurable: true, writable: true,
      enumerable: hookDescriptor?.enumerable ?? true, value: hookValue });
    else if (hookDescriptor) Object.defineProperty(globalThis, hookName, hookDescriptor);
    else delete globalThis[hookName];
    hookInstalled = false;
  }
  const hookAccess = {
    get() { return hookValue; },
    set(value) {
      // Preserve the application's assigned value even if observation refuses.
      hookValue = value; hookAssignments++;
      if (hookAssignments !== 1 || typeof value !== 'function' || attached) {
        fail('debug hook repeated/replaced'); return;
      }
      try { attach(); } catch (error) {
        fail(`renderer attachment failed: ${String(error).slice(0, 512)}`);
        restoreMethods();
      }
    },
  };
  let unsubscribe;
  try {
    unsubscribe = store.subscribe(observe);
    if (typeof unsubscribe !== 'function') refuse('subscription cleanup unavailable');
    Object.defineProperty(globalThis, hookName, { configurable: true,
      enumerable: hookDescriptor?.enumerable ?? true, get: hookAccess.get, set: hookAccess.set });
    hookInstalled = true;
    // Already-mounted empty Viewports are supported, but never required.
    if (document.querySelector('canvas')) attach(true);
    const witness = {
      discover, store, get renderer() { return renderer; }, get scene() { return scene; }, referenceAudit, bounds,
      freeze() {
        if (disposed || frozen) refuse('witness cannot freeze twice/disposed');
        observe(store.getState()); frozen = true;
        if (failure) refuse(failure);
        if (!attached) refuse('renderer was never attached before ingestion');
        verifyHook();
        if (deliveries.some(item => item.ingestions !== 1) || inputs.some(item => !item.accepted)) refuse('undrained/unaccepted delivered instance input');
        if (!model || !dataStore || modelId === null) refuse('loaded model/store not observed');
        return { deliveries, inputs, revision, modelId, model, dataStore, device, retainedBytes, calls };
      },
      validate(epoch) {
        if (failure || disposed || !frozen || epoch !== revision) refuse(failure ?? 'witness revision/lifecycle changed');
        verifyHook();
        if (restorations.some(item => scene[item.name] !== item.installed)) refuse('native method witness replaced');
        const now = discover();
        if (now.renderer !== renderer || now.scene !== scene || (device && renderer.getGPUDevice() !== device)) refuse('renderer/Scene/device replaced');
        const next = store.getState();
        if (next.models.size !== 1 || !next.models.has(modelId) || next.models.get(modelId)?.ifcDataStore !== dataStore) refuse('current model/store changed');
        return now;
      },
      dispose() {
        if (disposed) return;
        disposed = true; unsubscribe();
        restoreMethods(); restoreHook();
        deliveries.length = 0; inputs.length = 0; byBuffer.clear();
        delete globalThis.__ifc_lite_input_witness__;
        return { restored: !failure, failure };
      },
    };
    globalThis.__ifc_lite_input_witness__ = witness;
    return { registered: true, awaitsRendererReady: !attached, attachment: 'canonical-debug-hook-before-initialized', referenceAudit, bounds };
  } catch (error) {
    unsubscribe?.(); restoreMethods(); restoreHook();
    throw error;
  }
}
