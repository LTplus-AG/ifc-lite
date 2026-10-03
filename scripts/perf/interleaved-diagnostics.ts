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
  const getState = store && typeof store === 'object' ? Reflect.get(store, 'getState') : undefined;
  const state: unknown = typeof getState === 'function' ? Reflect.apply(getState, store, []) : undefined;
  return { capturedUTC: new Date().toISOString(), pagePerformanceMs: performance.now(),
    visibility: document.visibilityState, rendererDebugHookPresent: hookPresent,
    // The hook is installed after renderer.init(), before React's initialized flag commits.
    implication: 'hook presence witnesses init completion only; not device health or a completed frame',
    loading: state && typeof state === 'object' ? Reflect.get(state, 'loading') : null,
    streaming: state && typeof state === 'object' ? Reflect.get(state, 'geometryStreamingActive') : null };
}

/** Refused-only page callback; bounded scalar census, no buffer hashing or GPU work. */
export function refusedRendererSnapshot() {
  const call = (owner: unknown, method: string): unknown => {
    if (!owner || typeof owner !== 'object') return null;
    const fn = Reflect.get(owner, method);
    return typeof fn === 'function' ? Reflect.apply(fn, owner, []) : null;
  };
  const field = (owner: unknown, key: string): unknown => owner && typeof owner === 'object' ? Reflect.get(owner, key) : null;
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
  for (; fiber && parents < 200; parents++, fiber = field(fiber, 'return')) {
    if (seen.has(fiber)) throw new Error('diagnostic fiber cycle');
    seen.add(fiber);
    let hook = field(fiber, 'memoizedState');
    let hops = 0;
    for (; hook && hops < 200; hops++, hook = field(hook, 'next')) {
      const candidate = field(field(hook, 'memoizedState'), 'current');
      if (typeof field(candidate, 'getScene') === 'function' && typeof field(candidate, 'isReady') === 'function') {
        if (renderer && renderer !== candidate) throw new Error('ambiguous diagnostic renderer');
        renderer = candidate;
      }
    }
    if (hook) hookCapExhausted = true;
  }
  const scene = call(renderer, 'getScene'), batches = call(scene, 'getBatchedMeshes');
  const flatOwners = field(scene, 'meshDataMap'), instanceOwners = field(scene, 'instancedEntityMap');
  const geometry = field(field(state, 'geometryResult'), 'meshes');
  const modelGeometry = field(field(model, 'geometryResult'), 'meshes');
  return { capturedUTC: new Date().toISOString(), pagePerformanceMs: performance.now(),
    visibility: document.visibilityState, rendererFound: !!renderer, rendererReady: call(renderer, 'isReady'),
    traversal: { fiberCapExhausted: !!fiber, hookCapExhausted, visitedFibers: parents,
      complete: !fiber && !hookCapExhausted },
    canvas: canvas ? { width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight } : null,
    load: { loading: field(state, 'loading'), streaming: field(state, 'geometryStreamingActive'),
      error: field(state, 'error'), progress: field(state, 'loadingProgress'),
      modelCount: models instanceof Map ? models.size : null, geometryMeshes: Array.isArray(geometry) ? geometry.length : null },
    model: { loadState: field(model, 'loadState'), geometryLoadState: field(model, 'geometryLoadState'),
      metadataLoadState: field(model, 'metadataLoadState'), interactiveReady: field(model, 'interactiveReady'),
      geometryMeshes: Array.isArray(modelGeometry) ? modelGeometry.length : null },
    scene: { queued: call(scene, 'hasQueuedMeshes'), fragments: call(scene, 'hasStreamingFragments'),
      finalizing: call(scene, 'isFinalizeInProgress'), batchCount: Array.isArray(batches) ? batches.length : null,
      flatOwners: flatOwners instanceof Map ? flatOwners.size : null,
      instanceOwners: instanceOwners instanceof Map ? instanceOwners.size : null,
      instancedCount: call(scene, 'getInstancedEntityCount') },
    frame: call(renderer, 'getFrameStats'),
    limitations: 'Passive private-shape census only; null means unavailable, not zero. Frame stats witness CPU submission, not GPU completion or pixel fidelity.' };
}
