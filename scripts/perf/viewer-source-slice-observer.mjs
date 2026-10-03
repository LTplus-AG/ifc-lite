/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Self-contained prospective addInitScript callback. No buffer is retained.
 * Native delegation happens first; instrumentation never replaces its result
 * or exception. This witness is not a timing or physical-memory measurement. */
export function installSourceSliceObserver(config) {
  if (!config || !Number.isSafeInteger(config.bytes) || config.bytes < 1
    || typeof config.fileName !== 'string' || !config.fileName)
    throw new Error('REFUSE: invalid source slice observer configuration');
  const host = globalThis;
  const key = '__ifc_lite_source_slice_observer__';
  if (host[key]) throw new Error('REFUSE: source slice observer already installed');
  const proto = Uint8Array.prototype;
  const sliceDescriptor = Object.getOwnPropertyDescriptor(proto, 'slice');
  let logDescriptor = Object.getOwnPropertyDescriptor(console, 'log');
  const nativeSlice = proto.slice;
  let nativeLog = console.log;
  let armed = false;
  const sourceIds = new WeakMap();
  const state = { bytes: config.bytes, fileName: config.fileName,
    calls: [], milestones: {}, sourceIds: 0, error: null, frozen: false };
  const { fail, observe, log, slice, freeze, armMilestones } = {
    fail(error) {
      state.error ??= typeof error === 'string' ? error.slice(0, 512) : `observer metadata failed (${typeof error})`;
    },
    observe(view, result) {
      if (state.frozen || !ArrayBuffer.isView(view) || view.byteLength !== config.bytes
        || view.byteOffset !== 0 || view.buffer.byteLength !== config.bytes) return;
      if (!(view instanceof Uint8Array) || !ArrayBuffer.isView(result)) {
        fail('unsupported actual full-source view/result'); return;
      }
      if (state.calls.length >= 32) { fail('source slice record cap'); return; }
      let sourceId = sourceIds.get(view.buffer);
      if (!sourceId) { sourceId = ++state.sourceIds; sourceIds.set(view.buffer, sourceId); }
      let outputId = sourceIds.get(result.buffer);
      if (!outputId) { outputId = ++state.sourceIds; sourceIds.set(result.buffer, outputId); }
      const stack = new Error('actual native source slice').stack ?? '';
      if (stack.length > 8192) { fail('source slice stack cap'); return; }
      state.calls.push({ pageMs: performance.now(), sourceId, outputId,
        inputKind: typeof SharedArrayBuffer !== 'undefined' && view.buffer instanceof SharedArrayBuffer ? 'SharedArrayBuffer' : 'ArrayBuffer',
        inputByteOffset: view.byteOffset, inputViewBytes: view.byteLength,
        inputBufferBytes: view.buffer.byteLength, outputBytes: result.byteLength,
        outputByteOffset: result.byteOffset, outputBufferBytes: result.buffer.byteLength,
        wholeSourceBytesCopied: result.byteLength === config.bytes,
        outputKind: result.buffer instanceof ArrayBuffer ? 'ArrayBuffer' : 'other',
        milestones: { ...state.milestones }, stack });
    },
    slice(...args) {
      const result = Reflect.apply(nativeSlice, this, args);
      try { observe(this, result); }
      catch (error) { fail(error); }
      return result;
    },
    log(...args) {
      try {
        if (!state.frozen && typeof args[0] === 'string') {
          const line = args[0];
          let milestone;
          if (line.startsWith(`[useIfc] File: ${config.fileName}, size:`)) milestone = 'sourceAcquired';
          else if (line.startsWith('[stream] processParallel start,')) milestone = 'parallelStart';
          else if (line.startsWith(`[useIfc] Stream complete for ${config.fileName}:`)) milestone = 'geometryComplete';
          else if (line.startsWith(`[useIfc] Data model parsing complete for ${config.fileName}:`)) milestone = 'metadataComplete';
          else if (line.startsWith(`[useIfcCache] Starting cache write for: ${config.fileName} (persistSource=`)) milestone = 'cacheStart';
          else if (line === '[useIfcCache] Saving to cache storage...') milestone = 'cacheSaving';
          if (milestone) {
            if (Object.hasOwn(state.milestones, milestone)) fail(`duplicate ${milestone} milestone`);
            else state.milestones[milestone] = performance.now();
          }
        }
      } catch (error) { fail(error); }
      return Reflect.apply(nativeLog, this, args);
    },
    armMilestones() {
      if (armed || state.frozen) throw new Error('REFUSE: milestone observer already armed/frozen');
      armed = true;
      logDescriptor = Object.getOwnPropertyDescriptor(console, 'log');
      nativeLog = console.log;
      Object.defineProperty(console, 'log', {value:log,writable:true,configurable:true,enumerable:logDescriptor?.enumerable ?? false});
    },
    freeze(sourceBuffer) {
      if (state.frozen) throw new Error('REFUSE: source observer already frozen');
      state.frozen = true;
      let sourceId = sourceBuffer ? sourceIds.get(sourceBuffer) ?? null : null;
      const sourceKind = sourceBuffer instanceof ArrayBuffer ? 'ArrayBuffer'
        : typeof SharedArrayBuffer !== 'undefined' && sourceBuffer instanceof SharedArrayBuffer ? 'SharedArrayBuffer' : null;
      if (sourceKind && sourceBuffer.byteLength === config.bytes && sourceId === null) {
        sourceId = ++state.sourceIds; sourceIds.set(sourceBuffer, sourceId);
      }
      if (proto.slice === slice) {
        if (sliceDescriptor) Object.defineProperty(proto, 'slice', sliceDescriptor);
        else delete proto.slice;
      } else fail('slice observer replaced by foreign code');
      if (!armed) fail('milestone observer was never armed');
      if (armed && console.log === log) {
        if (logDescriptor) Object.defineProperty(console, 'log', logDescriptor);
        else delete console.log;
      } else fail('log observer replaced by foreign code');
      return { ...state, calls: state.calls.map(row => ({ ...row, milestones: { ...row.milestones } })),
        milestones: { ...state.milestones }, canonicalMetadataSource: sourceKind && sourceBuffer.byteLength === config.bytes
          ? { bytes: sourceBuffer.byteLength, kind: sourceKind, sourceId } : null,
        restorationExact: proto.slice === nativeSlice && console.log === nativeLog,
        scope: 'actual delegated slice inputs/results; no physical RSS or normal timing verdict' };
    },
  };
  Object.defineProperty(proto, 'slice', { value: slice, writable: true, configurable: true });
  if (config.deferMilestones !== true) armMilestones();
  host[key] = Object.freeze({ freeze, armMilestones });
}

/** The first parallel-start log precedes the actual default-pool prepass.
 * Cache materialization is evaluated before saveToCache logs, so only ordering
 * and the frozen source's sole remaining ordinary-IFC consumer prove its role. */
export function classifySourceSlices(receipt) {
  if (receipt.error || !receipt.restorationExact || !receipt.frozen || !receipt.canonicalMetadataSource
    || receipt.canonicalMetadataSource.bytes !== receipt.bytes)
    throw new Error(`REFUSE: incomplete slice observer: ${receipt.error ?? 'restoration/freeze'}`);
  const required = ['sourceAcquired', 'parallelStart', 'geometryComplete', 'metadataComplete'];
  if (required.some(key => !Number.isFinite(receipt.milestones[key]))
    || !(receipt.milestones.sourceAcquired <= receipt.milestones.parallelStart
      && receipt.milestones.parallelStart <= receipt.milestones.geometryComplete))
    throw new Error('REFUSE: missing/invalid canonical producer ordering');
  const reachableSources = new Set([receipt.canonicalMetadataSource.sourceId]);
  // A real native full-copy edge preserves bytes in either direction. This
  // recognizes a fallback's resident owned metadata source and its upstream SAB.
  for (let step = 0; step <= receipt.calls.length; step++) {
    const prior = reachableSources.size;
    for (const call of receipt.calls) {
      if (call.wholeSourceBytesCopied && call.outputKind === 'ArrayBuffer'
        && call.outputBufferBytes === receipt.bytes && call.outputByteOffset === 0
        && (reachableSources.has(call.sourceId) || reachableSources.has(call.outputId))) {
        reachableSources.add(call.sourceId); reachableSources.add(call.outputId);
      }
    }
    if (reachableSources.size === prior) break;
    if (step === receipt.calls.length) throw new Error('REFUSE: copy ancestry traversal budget');
  }
  return receipt.calls.map(call => {
    if (!reachableSources.has(call.sourceId)) throw new Error('REFUSE: slice input origin is not canonical source or its observed copy');
    reachableSources.add(call.outputId);
    if (!call.wholeSourceBytesCopied) return { ...call, attribution: 'partial-source-view-copy' };
    if (call.outputKind !== 'ArrayBuffer' || call.outputBufferBytes !== receipt.bytes
      || call.outputByteOffset !== 0 || call.outputId === call.sourceId)
      throw new Error('REFUSE: unknown full-source slice output ownership/layout');
    if (call.pageMs >= receipt.milestones.sourceAcquired && call.pageMs < receipt.milestones.parallelStart)
      return { ...call, attribution: 'source-preparation-before-default-pool' };
    if (call.pageMs >= receipt.milestones.geometryComplete
      && Number.isFinite(receipt.milestones.cacheStart) && call.pageMs <= receipt.milestones.cacheStart)
      return { ...call, attribution: 'post-geometry-before-admitted-cache-start' };
    throw new Error('REFUSE: full-source slice attribution is unknown');
  });
}


/** Self-contained page callback; never materializes/decompresses source. */
export function freezeResidentSource(expectedBytes) {
  const store = globalThis.__ifc_lite_viewer_store__;
  if (!store || (typeof store !== 'function' && typeof store !== 'object') || typeof store.getState !== 'function')
    throw new Error('REFUSE: canonical viewer store unavailable');
  const state = Reflect.apply(store.getState, store, []);
  if (!(state.models instanceof Map) || state.models.size !== 1) throw new Error('REFUSE: expected one actual primary model');
  const model = state.models.values().next().value;
  const data = model?.ifcDataStore;
  if (!data || data !== state.ifcDataStore || !(data.entityCount > 0)) throw new Error('REFUSE: canonical metadata owner unavailable');
  const source = data.source;
  if (source?.isResident !== true || source.byteLength !== expectedBytes || typeof source.slice !== 'function')
    throw new Error('REFUSE: source is compressed/nonresident or not the actual fixture length');
  const view = Reflect.apply(source.slice, source, [0, 1]);
  if (!(view instanceof Uint8Array) || view.byteLength !== 1 || view.byteOffset !== 0 || view.buffer.byteLength !== expectedBytes)
    throw new Error('REFUSE: resident source accessor did not return the exact backing-store view');
  const observer = globalThis.__ifc_lite_source_slice_observer__;
  if (!observer || typeof observer.freeze !== 'function') throw new Error('REFUSE: source observer unavailable');
  return { ...Reflect.apply(observer.freeze, observer, [view.buffer]),
    owner: { modelId: model.id, entityCount: data.entityCount, isResident: true, borrowedViewBytes: 1 } };
}
