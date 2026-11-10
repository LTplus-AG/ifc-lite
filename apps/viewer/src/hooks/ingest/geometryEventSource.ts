/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a load's geometry comes from (#7955 M2-C): the exact kernel's
 * `processAdaptive` stream, or — only in a `VITE_RETAINED_GEOMETRY=on` build,
 * and only when the user asked for it — the retained kernel's.
 *
 * `useIfcLoader` decides the kernel ONCE per load (`beginGeometryKernel`) and
 * asks it three things: may this source be loaded at all, may the exact cache
 * and server serve it, and where do its geometry events come from. The default
 * build resolves `@ifc-lite/viewer-retained` to a `null` stub, so every answer
 * is the exact one and the exact options below are exactly what the loader
 * passed inline before.
 */

import {
  assertGeometryMemoryFits, DEFAULT_HUNG_JOB_TIMEOUT_MS, GeometryMemoryBudgetError,
  type GeometryProcessor, type StallPhaseHandle, type StreamingGeometryEvent,
} from '@ifc-lite/geometry';
import { retainedKernel } from '@ifc-lite/viewer-retained';
import { useViewerStore } from '@/store';
import { showLoadError } from '@/lib/analytics';
import { formatLoadError } from '../../lib/load-error-message.js';
import { settleUnownedLoadUi } from '../modelLoadCanceller.js';
import { getGeomWorkerOverrideRequest } from '../../store/constants.js';
import { getDynamicBatchConfig, USE_SERVER } from '../../utils/ifcConfig.js';
import type { CachePlan } from '../cacheTier.js';

type AdaptiveOptions = NonNullable<Parameters<GeometryProcessor['processAdaptive']>[1]>;

/** Everything a geometry stream needs from the load that opens it. */
export interface GeometryEventRequest {
  processor: GeometryProcessor;
  /** The source bytes; a view of the parser's SharedArrayBuffer when one is shared. */
  view: Uint8Array;
  fileSizeMB: number;
  signal: AbortSignal;
  stallPhaseHandle: StallPhaseHandle;
  existingSab?: SharedArrayBuffer;
  sharedRtcOffset?: AdaptiveOptions['sharedRtcOffset'];
  onEntityIndex: NonNullable<AdaptiveOptions['onEntityIndex']>;
  sourceFingerprint?: SharedArrayBuffer;
  trace: AdaptiveOptions['trace'];
  modelId: string;
  /** The load's activity; a retained run installs `interrupt` so Cancel keeps what it published. */
  activity: { interrupt?: () => void; fail(message: string): string };
}

/** The kernel one load runs on, decided before any work. */
export interface GeometryKernelLoad {
  readonly kind: 'exact' | 'retained';
  /** Set when the request is out of the kernel's scope; resolves to the refusal message it reported, `null` for a quiet stop. */
  readonly refused?: Promise<string | null>;
  /** Whether the exact geometry server may serve this load. */
  readonly serverEnabled: boolean;
  /** The cache plan this load may use: retained loads never read or write exact geometry. */
  cachePlan(plan: CachePlan): CachePlan;
  /**
   * Once the format and unwrapped size are known: true when this load must stop
   * here. The refusal is reported and the model record marked; the caller ends
   * its load UI and returns.
   */
  refuseSource(format: string, byteLength: number, request: Pick<GeometryEventRequest, 'modelId' | 'activity'>): boolean;
  /** The kernel's own event stream; absent for exact, which streams through `processAdaptive`. */
  events?(request: GeometryEventRequest): AsyncIterable<StreamingGeometryEvent>;
  /** A geometry failure this kernel words itself; `retry` replaces the load's own (a retained run out of memory retries exact). */
  loadFailure?(error: unknown): { message: string; retry?: () => void } | null;
}

/**
 * The exact kernel's one refusal: even the source copies the load must hold
 * on the path that will run (3 × source for the worker pool, 2 × for the
 * serial fallback) exceed the most memory the browser's `deviceMemory` reading
 * allows (`assertGeometryMemoryFits` in `@ifc-lite/geometry`). A configured
 * geometry server may still take the load, so nothing is refused then. Retry
 * waives it for that file: the reading is not proof (swap, compression), so the
 * user can always try anyway.
 */
const memoryRefusalWaived = new WeakSet<File>();

function memoryRefusal(file: File, byteLength: number): string | null {
  if (USE_SERVER || memoryRefusalWaived.has(file)) return null;
  try {
    assertGeometryMemoryFits(byteLength);
    return null;
  } catch (err) {
    if (err instanceof GeometryMemoryBudgetError) return formatLoadError(err, file.name);
    throw err;
  }
}

/** Shown like every load error; its Retry tries the same file anyway, without the refusal. */
function reportMemoryRefusal(message: string, file: File, retry: () => void): void {
  const { setError, setLastLoadRetry } = useViewerStore.getState();
  const tryAnyway = () => { memoryRefusalWaived.add(file); retry(); };
  showLoadError(setError, setLastLoadRetry, message, 'device_memory_insufficient', tryAnyway, file);
}

function exactGeometryKernel(file: File, retry: () => void): GeometryKernelLoad {
  return {
    kind: 'exact',
    serverEnabled: true,
    cachePlan: (plan) => plan,
    // An `.ifczip` is only measurable once unwrapped, so its refusal comes here.
    refuseSource(format, byteLength, { modelId, activity }) {
      const message = format === 'ifc' ? memoryRefusal(file, byteLength) : null;
      if (!message) return false;
      const shown = activity.fail(message);
      useViewerStore.getState().updateModel(modelId, { loadState: 'error', loadError: shown });
      reportMemoryRefusal(shown, file, retry);
      return true;
    },
  };
}

/**
 * Decide the kernel for this load. A retained request outside retained scope
 * (federated add, non-STEP file, oversize source) comes back already refused,
 * before a byte is read or any Worker spawns. `retry` re-runs this same load;
 * a refusal offers it after switching the next load to the exact kernel.
 */
export function beginGeometryKernel(
  file: File,
  target: { kind: 'primary' | 'federated' },
  retry: () => void,
): GeometryKernelLoad {
  // `retainedKernel` is `null` in the default viewer (the alias maps to off.ts).
  const retained = retainedKernel?.begin(file, target, retry);
  if (retained) return retained;
  const exact = exactGeometryKernel(file, retry);
  // A plain `.ifc` file's size is its source size: refuse before a byte is read.
  const early = /\.ifc$/i.test(file.name) ? memoryRefusal(file, file.size) : null;
  if (!early) return exact;
  reportMemoryRefusal(early, file, retry);
  settleUnownedLoadUi();
  return { ...exact, refused: Promise.resolve(early) };
}

export function openGeometryEvents(kernel: GeometryKernelLoad, request: GeometryEventRequest): AsyncIterable<StreamingGeometryEvent> {
  if (kernel.events) return kernel.events(request);
  return request.processor.processAdaptive(request.view, {
    signal: request.signal,
    hungJobTimeoutMs: DEFAULT_HUNG_JOB_TIMEOUT_MS, // the loader reads skippedHungElements
    stallPhaseHandle: request.stallPhaseHandle,
    sizeThreshold: 2 * 1024 * 1024, // 2MB threshold
    // Dynamic batches: small first, then large.
    batchSize: getDynamicBatchConfig(request.fileSizeMB),
    existingSab: request.existingSab,
    // Federated adds share the anchor's RTC origin so all models sit in
    // one coordinate space (pixel-perfect alignment, no post-shift).
    sharedRtcOffset: request.sharedRtcOffset,
    // Let a geometry worker finish before materializing large parser
    // reference arrays. Small loads still receive immediately.
    // Refusal counts and malformed-stop diagnostics remain attached.
    onEntityIndex: request.onEntityIndex,
    sourceFingerprint: request.sourceFingerprint,
    // `?geomWorkers=N` A/B knob — overrides the cores/memory worker-
    // count policy so the host's thermal sweet spot can be measured. Only a
    // URL request may exceed the engine's tab-memory budget (never the device);
    // a remembered one stays clipped. Geometry output is unaffected by the
    // count (disjoint deterministic element slices).
    workerCountOverride: getGeomWorkerOverrideRequest(),
    trace: request.trace,
  });
}
