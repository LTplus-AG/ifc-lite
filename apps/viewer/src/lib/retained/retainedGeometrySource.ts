/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Host messages → the loader's `StreamingGeometryEvent`s (#7955 M2-C).
 *
 * One published product becomes one `batch` (products are atomic, so a batch
 * never carries part of one). A refused or never-reached product produces no
 * mesh at all; it only becomes a row of the `RetainedGeometrySummary`, which
 * is reported after every change. Nothing here ever asks the exact kernel for
 * anything: a refused product stays absent.
 *
 * The run owns its own stall budget (engine startup, then one product
 * deadline plus slack between host messages) and emits `progress` heartbeats
 * while it waits, so the loader's exact-path watchdog never fires on a slow
 * but healthy product.
 */

import type { CoordinateInfo, MeshData, StreamingGeometryEvent } from '@ifc-lite/geometry';
import { calculateMeshBounds, createCoordinateInfo } from '@/utils/localParsingUtils';
import type { RetainedFaceRow, RetainedGeometrySummary, RetainedUnpublishedRow } from '@/store/retainedGeometry';
import type { RetainedHostEvent, RetainedStart } from './retained-protocol';
import { recordRetainedPublication } from './retainedPublication';

/** The host client surface the source drives (`RetainedClient`, or a protocol fixture). */
export interface RetainedRunner {
  run(bytes: Uint8Array, options?: { signal?: AbortSignal }): AsyncGenerator<RetainedHostEvent>;
  cancel(): void;
}

/** Status-bar phases (§2.3); the caller words them. */
export type RetainedPhase =
  | { phase: 'starting' }
  | { phase: 'products'; done: number; candidates: number; refused: number };

export interface RetainedSourceOptions {
  /** The loader's hard abort (a superseding load): ends the run like Cancel. */
  signal?: AbortSignal;
  onSummary(summary: RetainedGeometrySummary): void;
  onPhase?(phase: RetainedPhase): void;
  onWorkerMemory?(wasmHeapBytes: number): void;
  /** Engine import, SMLib Worker start and qualification. */
  startupBudgetMs?: number;
  /** Between host messages once running: M1 `ProductBudgetSpec` deadline (30 s) + 5 s. */
  productBudgetMs?: number;
  heartbeatMs?: number;
}

export const RETAINED_STARTUP_BUDGET_MS = 60_000;
export const RETAINED_PRODUCT_BUDGET_MS = 30_000 + 5_000;
const SUMMARY_INTERVAL_MS = 250;

/** The host went silent past its budget. Never a resource-limit kind: no tier retry, no exact fallback. */
export class RetainedStallError extends Error {
  constructor(readonly budgetMs: number, readonly stage: 'startup' | 'product') {
    super(stage === 'startup'
      ? `Retained engine did not start within ${Math.ceil(budgetMs / 1000)} s`
      : `Retained engine produced no product for ${Math.ceil(budgetMs / 1000)} s`);
    this.name = 'RetainedStallError';
  }
}

interface Accumulator {
  summary: RetainedGeometrySummary;
  candidateIds: Uint32Array;
  received: Set<number>;
  obligations: Set<string>;
  bounds: ReturnType<typeof calculateMeshBounds>['bounds'] | null;
  frame: RetainedStart['frame'] | null;
  meshes: number;
  faces: Map<number, RetainedFaceRow[]>;
}

function snapshot(acc: Accumulator): RetainedGeometrySummary {
  return { ...acc.summary, refused: [...acc.summary.refused], obligationsUnmet: [...acc.obligations].sort(),
    ...(acc.faces.size > 0 ? { faces: Object.fromEntries(acc.faces) } : {}) };
}

/**
 * Each part's face table over its own view mesh (one mesh per part, M11-0), merged by key.
 * Rows keep source-table order (first part first), never triangle-encounter order.
 */
export function faceRows(faces: { table: string[]; triangles: Uint32Array }[], meshes: MeshData[]): RetainedFaceRow[] {
  const rows = new Map<string, RetainedFaceRow>();
  for (const part of faces) {
    for (const key of part.table) if (!rows.has(key)) rows.set(key, { key, triangles: 0, areaM2: 0 });
  }
  faces.forEach((part, i) => {
    const mesh = meshes[i];
    for (let t = 0; t < part.triangles.length; t++) {
      const key = part.table[part.triangles[t]];
      const row = rows.get(key)!;
      row.triangles++;
      if (mesh && mesh.indices.length >= 3 * t + 3) {
        const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[3 * t + k] * 3);
        const u = [0, 1, 2].map((k) => mesh.positions[b + k] - mesh.positions[a + k]);
        const v = [0, 1, 2].map((k) => mesh.positions[c + k] - mesh.positions[a + k]);
        row.areaM2 += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
      }
    }
  });
  return [...rows.values()].filter((row) => row.triangles > 0);
}

function unpublished(acc: Accumulator, row: RetainedUnpublishedRow): void {
  acc.received.add(row.expressId);
  acc.summary.refused.push(row);
  if (row.code === 'cancelled') acc.summary.cancelled++;
}

/** Candidates the run never reached are listed, never silently dropped. */
function closeRun(acc: Accumulator, failure?: string): void {
  for (const expressId of acc.candidateIds) {
    if (!acc.received.has(expressId)) unpublished(acc, { expressId, ifcType: '', code: 'cancelled' });
  }
  acc.summary.completeness = acc.summary.refused.length > 0 ? 'incomplete' : 'complete';
  if (failure) acc.summary.failure = failure;
}

function coordinateInfo(acc: Accumulator): CoordinateInfo {
  const empty = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const info = createCoordinateInfo(acc.bounds ?? empty);
  const frame = acc.frame;
  if (!frame) return info;
  // The session's frame is the one `buildPrePassOnce` reports for these bytes
  // (M2-A), so it is published the way the exact streaming path publishes it.
  const [x, y, z] = frame.rtcOffset;
  return {
    ...info,
    ...(frame.needsShift ? { wasmRtcOffset: { x, y, z } } : {}),
    wasmRtcFrame: { x, y, z, needsShift: frame.needsShift },
  };
}

type Pulled = { event: RetainedHostEvent } | { done: true } | { idle: true };

/** One host message, or a heartbeat tick while waiting; throws past the stall budget. */
async function pull(
  iterator: AsyncIterator<RetainedHostEvent>,
  pending: { next?: Promise<IteratorResult<RetainedHostEvent>>; since: number },
  budgetMs: number,
  stage: 'startup' | 'product',
  heartbeatMs: number,
): Promise<Pulled> {
  pending.next ??= iterator.next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = new Promise<'tick'>((resolve) => { timer = setTimeout(() => resolve('tick'), heartbeatMs); });
  try {
    const result = await Promise.race([pending.next, tick]);
    if (result === 'tick') {
      if (performance.now() - pending.since >= budgetMs) throw new RetainedStallError(budgetMs, stage);
      return { idle: true };
    }
    pending.next = undefined;
    pending.since = performance.now();
    return result.done ? { done: true } : { event: result.value };
  } finally {
    clearTimeout(timer);
  }
}

export async function* retainedGeometryEvents(
  runner: RetainedRunner,
  bytes: Uint8Array,
  options: RetainedSourceOptions,
): AsyncGenerator<StreamingGeometryEvent> {
  const acc: Accumulator = {
    summary: { kernel: 'retained', candidates: 0, published: 0, refused: [], cancelled: 0, obligationsUnmet: [], completeness: 'running' },
    candidateIds: new Uint32Array(), received: new Set(), obligations: new Set(), bounds: null, frame: null, meshes: 0, faces: new Map(),
  };
  // Every product would otherwise copy the whole row list into the store: at
  // most one mid-run summary per interval, and every boundary at once.
  let lastReport = -Infinity;
  let unreported = false;
  const report = (throttled = false) => {
    const now = performance.now();
    if (throttled && now - lastReport < SUMMARY_INTERVAL_MS) { unreported = true; return; }
    lastReport = now;
    unreported = false;
    options.onSummary(snapshot(acc));
  };
  const phase = () => options.onPhase?.({
    phase: 'products', done: acc.received.size, candidates: acc.summary.candidates,
    refused: acc.summary.refused.length - acc.summary.cancelled,
  });
  const heartbeatMs = options.heartbeatMs ?? 1_000;
  const iterator = runner.run(bytes, { signal: options.signal });
  const pending: { next?: Promise<IteratorResult<RetainedHostEvent>>; since: number } = { since: performance.now() };
  let started = false;
  let finished = false;
  options.onPhase?.({ phase: 'starting' });
  report();
  try {
    while (true) {
      let pulled: Pulled;
      try {
        pulled = await pull(iterator, pending, started
          ? options.productBudgetMs ?? RETAINED_PRODUCT_BUDGET_MS
          : options.startupBudgetMs ?? RETAINED_STARTUP_BUDGET_MS, started ? 'product' : 'startup', heartbeatMs);
      } catch (error) {
        runner.cancel();
        closeRun(acc, error instanceof Error ? error.message : String(error));
        finished = true;
        report();
        throw error;
      }
      if ('idle' in pulled) {
        if (unreported) report();
        yield { type: 'progress', phase: 'workers' };
        continue;
      }
      if ('done' in pulled) break;
      const event = pulled.event;
      switch (event.kind) {
        case 'progress':
          yield { type: 'progress', phase: 'workers' };
          break;
        case 'start': {
          started = true;
          acc.candidateIds = event.candidateIds;
          acc.frame = event.frame;
          acc.summary.candidates = event.candidateIds.length;
          acc.summary.started = true;
          report();
          yield { type: 'start', totalEstimate: event.candidateIds.length };
          phase();
          break;
        }
        case 'published': {
          recordRetainedPublication(acc, event);
          if (event.faces) acc.faces.set(event.expressId, faceRows(event.faces, event.meshes));
          report(true);
          yield { type: 'batch', meshes: event.meshes, instancedShards: event.instancedShards, totalSoFar: acc.meshes, coordinateInfo: coordinateInfo(acc) };
          phase();
          break;
        }
        case 'refused':
          unpublished(acc, {
            expressId: event.expressId, ifcType: event.ifcType, code: event.code,
            ...(event.origin ? { origin: event.origin } : {}),
            ...(event.kernelStatus !== undefined ? { kernelStatus: event.kernelStatus } : {}),
          });
          report(true);
          phase();
          break;
        case 'cancelled':
          unpublished(acc, { expressId: event.expressId, ifcType: '', code: 'cancelled' });
          break;
        case 'workerMemory':
          options.onWorkerMemory?.(event.wasmHeapBytes);
          break;
        case 'complete':
          closeRun(acc);
          finished = true;
          report();
          yield { type: 'complete', totalMeshes: acc.meshes, coordinateInfo: coordinateInfo(acc) };
          return;
      }
    }
    // The host stream ended without `complete` (abandoned by the client).
    closeRun(acc);
    finished = true;
    report();
  } catch (error) {
    if (!finished) {
      closeRun(acc, error instanceof Error ? error.message : String(error));
      finished = true;
      report();
    }
    throw error;
  } finally {
    // An abandoned source (superseding load) must release the host too. Cancel
    // first: a host pull may still be outstanding, and the client settles it
    // only once the Worker is gone.
    if (!finished) runner.cancel();
    await iterator.return?.(undefined);
  }
}
