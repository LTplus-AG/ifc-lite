/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { openSync, closeSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';

/** A failed replacement must leave the last complete receipt available. */
export function writeAtomicEvidence(path: string, content: string | Uint8Array,
  write: (fd: number, content: string | Uint8Array) => void = writeFileSync): void {
  const temporary = `${path}.writing-${process.pid}`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, 'wx'); created = true;
    write(fd, content);
    const closing = fd; fd = undefined; closeSync(closing);
    renameSync(temporary, path); created = false;
  } finally {
    try { if (fd !== undefined) closeSync(fd); }
    finally {
      if (created) {
        try { unlinkSync(temporary); }
        catch (error) { console.error('Owned evidence temporary cleanup failed:', error); }
      }
    }
  }
}

export interface DiagnosticEvent {
  capturedUTC: string; elapsedMs: number; phase: string;
  kind: 'console' | 'pageerror' | 'crash'; text: string; level?: string; url?: string;
}
// Time/phase describe delivery to the Playwright observer, not producer execution.
export function diagnosticEvent(kind: DiagnosticEvent['kind'], text: string, phase: string,
  startedMs: number, nowMs = Date.now()): DiagnosticEvent {
  return { capturedUTC: new Date(nowMs).toISOString(), elapsedMs: nowMs - startedMs, phase, kind, text };
}

/** Serialization detaches the witness from arrays still receiving teardown events. */
export function frozenBeforeTeardown(row: { status: string; reason?: string },
  events: readonly DiagnosticEvent[], observed: unknown, nowMs = Date.now()) {
  const captured = JSON.stringify({ capturedUTC: new Date(nowMs).toISOString(), phase: 'before-teardown',
    status: row.status, reason: row.reason, events, observed }, null, 2);
  return { captured, sha256: createHash('sha256').update(captured).digest('hex') };
}

export async function boundedDiagnostic<T>(operation: Promise<T>, timeoutMs: number): Promise<
  { status: 'observed'; value: T } | { status: 'unavailable'; reason: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return { status: 'observed', value: await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('diagnostic deadline')), timeoutMs);
    })]) };
  } catch (error) { return { status: 'unavailable', reason: String(error) }; }
  finally { clearTimeout(timer); }
}

/** Self-contained passive page callback. Never initializes, renders or finalizes. */
export function passiveRendererWitness() {
  const host = globalThis as Record<string, unknown>;
  const hookPresent = typeof host.__ifc_lite_render_stats__ === 'function';
  const store = host.__ifc_lite_viewer_store__;
  const getState = store && (typeof store === 'object' || typeof store === 'function')
    ? Reflect.get(store, 'getState') : undefined;
  const state: unknown = typeof getState === 'function' ? Reflect.apply(getState, store, []) : undefined;
  return { capturedUTC: new Date().toISOString(), pagePerformanceMs: performance.now(),
    visibility: document.visibilityState, rendererDebugHookPresent: hookPresent,
    // The hook is installed after renderer.init(), before React's initialized flag commits.
    implication: 'hook presence witnesses init completion only; not device health or a completed frame',
    loading: state && typeof state === 'object' ? Reflect.get(state, 'loading') : null,
    streaming: state && typeof state === 'object' ? Reflect.get(state, 'geometryStreamingActive') : null };
}

/** Install once on a fresh page before upload; records fixed scalar milestones.
 * Console arguments/receiver are delegated unchanged. This instrumentation is
 * prospective observer overhead in both arms, not an uninstrumented timing claim. */
export function installReadinessMilestones() {
  const host = globalThis as Record<string, unknown>;
  if (host.__ifc_lite_comparison_milestones__) throw new Error('REFUSE: observer already installed');
  const record = { uploadMs: null as number | null, geometryMs: null as number | null,
    metadataMs: null as number | null, spatialMs: null as number | null,
    spatialFileName: null as string | null, metadataFileName: null as string | null,
    spatialCount: 0, uploadCount: 0, geometryCount: 0, metadataCount: 0,
    error: null as string | null };
  host.__ifc_lite_comparison_milestones__ = record;
  const original = console.log;
  const { change, log } = {
    change(event: Event) {
      if (event.target !== document.querySelector('input[type="file"]')) return;
      record.uploadCount++;
      const files = event.target instanceof HTMLInputElement ? event.target.files : null;
      if (record.uploadCount !== 1 || files?.length !== 1) record.error = 'expected first single-file upload';
      else record.uploadMs = performance.now();
    },
    log(...args: unknown[]) {
      if (record.uploadMs !== null && typeof args[0] === 'string') {
        const spatial = /^\[useIfc\] Spatial tree ready for (.+) at [\d.]+ms$/.exec(args[0]);
        if (spatial) { record.spatialCount++; record.spatialMs = performance.now(); record.spatialFileName = spatial[1]; }
        if (/^\[useIfc\] (?:Native )?(?:Stream complete|Geometry streaming complete)/.test(args[0])) {
          record.geometryCount++;
          record.geometryMs = performance.now();
        }
        if (/^\[useIfc\] (?:Native )?(?:metadata|Data model) (?:parse|parsing) complete/i.test(args[0])) {
          record.metadataCount++;
          record.metadataMs = performance.now();
          const metadata = /^\[useIfc\] Data model parsing complete for (.+): [\d.]+ms$/.exec(args[0]);
          record.metadataFileName = metadata?.[1] ?? null;
        }
        if (record.geometryCount > 8 || record.metadataCount > 8 || record.spatialCount > 8) record.error = 'milestone record budget exceeded';
      }
      Reflect.apply(original, this, args);
    },
  };
  document.addEventListener('change', change, true);
  console.log = log;
}

/** Shared readonly page callback for refusal diagnostics and strict readiness. */
export function refusedRendererSnapshot() {
  // Object methods preserve their names without a transpiler's external __name
  // helper. Playwright serializes this function without its module closure.
  const { call, field } = {
    call(owner: unknown, method: string): unknown {
      if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) return null;
      const fn = Reflect.get(owner, method);
      return typeof fn === 'function' ? Reflect.apply(fn, owner, []) : null;
    },
    field(owner: unknown, key: string): unknown {
      return owner && (typeof owner === 'object' || typeof owner === 'function') ? Reflect.get(owner, key) : null;
    },
  };
  const host = globalThis as Record<string, unknown>;
  const state = call(host.__ifc_lite_viewer_store__, 'getState');
  const models = field(state, 'models');
  const model: unknown = models instanceof Map && models.size === 1 ? models.values().next().value : null;
  const canvas = document.querySelector('canvas');
  const key = canvas && Object.keys(canvas).find(name => name.startsWith('__reactFiber$'));
  let fiber: unknown = canvas && key ? Reflect.get(canvas, key) : null;
  const seen = new Set<unknown>();
  let renderer: unknown;
  let parents = 0;
  let hookCapExhausted = false;
  let totalHooks = 0;
  const hookWalks: Array<{ tag: number; hooks: number }> = [];
  for (; fiber && parents < 200; parents++, fiber = field(fiber, 'return')) {
    if (seen.has(fiber)) throw new Error('diagnostic fiber cycle');
    seen.add(fiber);
    const tag = field(fiber, 'tag');
    if (typeof tag !== 'number' || !Number.isSafeInteger(tag) || tag < 0 || tag > 31) {
      throw new Error('unknown diagnostic React fiber tag');
    }
    // React FunctionComponent, ForwardRef, MemoComponent and SimpleMemoComponent.
    // Other tags' memoizedState is not necessarily a Hook list.
    if (tag !== 0 && tag !== 11 && tag !== 14 && tag !== 15) continue;
    let hook = field(fiber, 'memoizedState');
    let hops = 0;
    const hookSeen = new Set<unknown>();
    for (; hook && hops < 2048 && totalHooks < 65536; hops++, totalHooks++, hook = field(hook, 'next')) {
      if (typeof hook !== 'object' || hook === null) throw new Error('unknown diagnostic Hook shape');
      const next = field(hook, 'next');
      if (next !== null && (typeof next !== 'object' || next === undefined)) throw new Error('unknown diagnostic Hook next');
      if (hookSeen.has(hook)) throw new Error('diagnostic hook cycle');
      hookSeen.add(hook);
      const candidate = field(field(hook, 'memoizedState'), 'current');
      if (typeof field(candidate, 'getScene') === 'function' && typeof field(candidate, 'isReady') === 'function') {
        if (renderer && renderer !== candidate) throw new Error('ambiguous diagnostic renderer');
        renderer = candidate;
      }
    }
    hookWalks.push({ tag, hooks: hops });
    if (hook) hookCapExhausted = true;
  }
  const scene = call(renderer, 'getScene'), batches = call(scene, 'getBatchedMeshes');
  const flatOwners = field(scene, 'meshDataMap'), instanceOwners = field(scene, 'instancedEntityMap');
  const geometry = field(field(state, 'geometryResult'), 'meshes');
  const pendingShards = field(state, 'pendingInstancedShards');
  const templates = call(scene, 'getInstancedTemplates');
  const debug = typeof host.__ifc_lite_render_stats__ === 'function'
    ? Reflect.apply(host.__ifc_lite_render_stats__, host, []) : null;
  const frame = call(renderer, 'getFrameStats');
  const modelGeometry = field(field(model, 'geometryResult'), 'meshes');
  return { capturedUTC: new Date().toISOString(), pagePerformanceMs: performance.now(),
    visibility: document.visibilityState, rendererFound: !!renderer, rendererReady: call(renderer, 'isReady'),
    traversal: { fiberCapExhausted: !!fiber, hookCapExhausted, visitedFibers: parents,
      complete: !fiber && !hookCapExhausted, totalHooks, hookWalks },
    canvas: canvas ? { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight } : null,
    load: { loading: field(state, 'loading'), streaming: field(state, 'geometryStreamingActive'),
      error: field(state, 'error'), progress: field(state, 'loadingProgress'),
      activeModelId: field(state, 'activeModelId'),
      pendingInstanceShards: pendingShards === null ? 0 : Array.isArray(pendingShards) ? pendingShards.length : null,
      modelCount: models instanceof Map ? models.size : null, geometryMeshes: Array.isArray(geometry) ? geometry.length : null },
    model: { id: field(model, 'id'), loadError: field(model, 'loadError'),
      dataStorePresent: !!field(model, 'ifcDataStore'), loadState: field(model, 'loadState'), geometryLoadState: field(model, 'geometryLoadState'),
      metadataLoadState: field(model, 'metadataLoadState'), interactiveReady: field(model, 'interactiveReady'),
      geometryMeshes: Array.isArray(modelGeometry) ? modelGeometry.length : null },
    scene: { pendingBatches: call(scene, 'hasPendingBatches'),
      geometryReleased: call(scene, 'isGeometryDataReleased'), queued: call(scene, 'hasQueuedMeshes'), fragments: call(scene, 'hasStreamingFragments'),
      finalizing: call(scene, 'isFinalizeInProgress'), batchCount: Array.isArray(batches) ? batches.length : null,
      flatOwners: flatOwners instanceof Map ? flatOwners.size : null,
      instanceOwners: instanceOwners instanceof Map ? instanceOwners.size : null,
      instancedCount: call(scene, 'getInstancedEntityCount'),
      gpuInstanceOccurrences: Array.isArray(templates) && templates.every(template =>
        typeof field(template, 'instanceCount') === 'number' && Number.isSafeInteger(field(template, 'instanceCount')))
        ? templates.reduce((sum: number, template: unknown) => sum + Number(field(template, 'instanceCount')), 0) : null },
    milestones: host.__ifc_lite_comparison_milestones__,
    frame, debugFrameMatches: frame !== null && field(debug, 'frame') === frame,
    limitations: 'Passive private-shape census only; null means unavailable, not zero. Frame stats witness CPU submission, not GPU completion or pixel fidelity.' };
}
