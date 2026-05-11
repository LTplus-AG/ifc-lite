/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parser Web Worker.
 *
 * Receives a SharedArrayBuffer view of the IFC file bytes, runs
 * `IfcParser.parseColumnar` off the main thread, and posts back two
 * messages — `partial-store` (after spatial hierarchy is ready, for the
 * fast hierarchy panel paint) and `complete` (full store with on-demand
 * maps) — each carrying the column data plus a transferable list.
 *
 * The worker disables the inner scan-worker spawn (`disableWorkerScan: true`)
 * because nesting workers serves no purpose and adds postMessage latency.
 */

import init, { IfcAPI } from '@ifc-lite/wasm';
import { IfcParser } from './index.js';
import type { IfcDataStore } from './columnar-parser.js';
import {
  collectTransferables,
  toTransport,
  transportByteSize,
  type DataStoreTransport,
  type ParserMemorySnapshot,
} from './data-store-transport.js';

/** Input message: pass the SAB-backed source bytes and an opaque request id. */
export interface ParserWorkerInputMessage {
  type: 'parse';
  id: string;
  source: SharedArrayBuffer;
  /** Optional yieldIntervalMs override (forwarded to parseColumnar). */
  yieldIntervalMs?: number;
  /** Defer indexing of property atoms (huge-file mode). */
  deferPropertyAtomIndex?: boolean;
  /**
   * If set, the worker holds the parse before the WASM scan until a
   * `set-entity-index` message arrives. The streaming geometry pre-pass
   * already builds the same index in another worker — handing it across
   * via SAB lets us skip a second 6–10 s file scan.
   */
  waitForEntityIndex?: boolean;
}

/** Hand the worker a pre-built entity index (typically from the geometry pre-pass). */
export interface ParserWorkerEntityIndexMessage {
  type: 'set-entity-index';
  ids: Uint32Array;
  starts: Uint32Array;
  lengths: Uint32Array;
}

/** Progress update from the worker. */
export interface ParserWorkerProgressMessage {
  type: 'progress';
  id: string;
  progress: { phase: string; percent: number };
}

/** Optional structured diagnostic line (mirrors parseColumnar `onDiagnostic`). */
export interface ParserWorkerDiagnosticMessage {
  type: 'diagnostic';
  id: string;
  message: string;
}

/** Hierarchy is ready — UI can render the spatial panel before full parse completes. */
export interface ParserWorkerPartialStoreMessage {
  type: 'partial-store';
  id: string;
  payload: DataStoreTransport;
}

/** Full data store is ready. */
export interface ParserWorkerCompleteMessage {
  type: 'complete';
  id: string;
  payload: DataStoreTransport;
  memory: ParserMemorySnapshot;
}

export interface ParserWorkerErrorMessage {
  type: 'error';
  id: string;
  message: string;
}

export type ParserWorkerOutputMessage =
  | ParserWorkerProgressMessage
  | ParserWorkerDiagnosticMessage
  | ParserWorkerPartialStoreMessage
  | ParserWorkerCompleteMessage
  | ParserWorkerErrorMessage;

interface JsHeapPerf {
  memory?: { usedJSHeapSize: number };
}

function readJsHeapBytes(): number | undefined {
  const perf = performance as unknown as JsHeapPerf;
  return perf.memory?.usedJSHeapSize;
}

interface MeasureUaMemoryPerf {
  measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
}

async function readUaMemoryBytes(): Promise<number | undefined> {
  const perf = performance as unknown as MeasureUaMemoryPerf;
  if (typeof perf.measureUserAgentSpecificMemory !== 'function') return undefined;
  try {
    const sample = await perf.measureUserAgentSpecificMemory();
    return sample.bytes;
  } catch {
    /* cleanup — safe to ignore: best-effort telemetry probe.
     * Throws on browsers that don't support measureUserAgentSpecificMemory
     * yet (Firefox until recently, Safari) or when the page lacks
     * crossOriginIsolated. None are recoverable from here. */
    return undefined;
  }
}

function postOutput(message: ParserWorkerOutputMessage, transfers?: Transferable[]): void {
  const w = self as unknown as Worker;
  if (transfers && transfers.length > 0) {
    w.postMessage(message, transfers);
  } else {
    w.postMessage(message);
  }
}

/**
 * One-shot WASM init. The first parse pays ~50–100 ms to compile the
 * 1 MB module; subsequent parses on the same worker reuse the instance.
 *
 * The WASM `IfcAPI` exposes `scanRelevantEntitiesFastBytes` (filters to
 * ~1 % of entities — too narrow for the lite parser, which needs to find
 * IFCSIUNIT, IFCMATERIAL, IFCCLASSIFICATIONREFERENCE, etc.) and
 * `scanEntitiesFastBytes` (full Rust scan, 5–10× faster than the JS
 * tokenizer). We expose only the latter so `parseColumnar`'s preference
 * logic picks the full scan unconditionally.
 */
let cachedFullScanApi: { scanEntitiesFastBytes(data: Uint8Array): unknown } | null = null;
let initPromise: Promise<void> | null = null;

async function ensureWasmScanApi(): Promise<{ scanEntitiesFastBytes(data: Uint8Array): unknown }> {
  if (cachedFullScanApi) return cachedFullScanApi;
  if (!initPromise) initPromise = init().then(() => {});
  await initPromise;
  const api = new IfcAPI();
  cachedFullScanApi = {
    // Bind so `parseColumnar` can call without needing the IfcAPI receiver.
    scanEntitiesFastBytes: api.scanEntitiesFastBytes.bind(api),
  };
  return cachedFullScanApi;
}

/**
 * Promise/handoff for a pre-built entity index from the streaming geometry
 * pre-pass. When the host posts `set-entity-index`, we resolve the pending
 * waiter (if any) and stash the columns for the next `parse`.
 */
let pendingEntityIndex: {
  ids: Uint32Array;
  starts: Uint32Array;
  lengths: Uint32Array;
} | null = null;
let entityIndexWaiter: ((value: NonNullable<typeof pendingEntityIndex>) => void) | null = null;

function takeEntityIndex(): NonNullable<typeof pendingEntityIndex> | null {
  if (!pendingEntityIndex) return null;
  const taken = pendingEntityIndex;
  pendingEntityIndex = null;
  return taken;
}

/**
 * Wait for an entity-index handoff with a watchdog timeout. If the host
 * promised one via `waitForEntityIndex` but never delivers (path mismatch,
 * pre-pass aborted, etc.), we fall through to the regular WASM scan after
 * the timeout instead of hanging the parse forever.
 */
function awaitEntityIndex(timeoutMs: number): Promise<NonNullable<typeof pendingEntityIndex> | null> {
  const taken = takeEntityIndex();
  if (taken) return Promise.resolve(taken);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      entityIndexWaiter = null;
      console.warn(`[parser.worker] entity-index timeout after ${timeoutMs}ms — falling back to WASM scan`);
      resolve(null);
    }, timeoutMs);
    entityIndexWaiter = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingEntityIndex = null;
      resolve(value);
    };
  });
}

type ParserInbound = ParserWorkerInputMessage | ParserWorkerEntityIndexMessage;

self.onmessage = async (event: MessageEvent<ParserInbound>) => {
  const data = event.data;
  if (data.type === 'set-entity-index') {
    pendingEntityIndex = {
      ids: data.ids,
      starts: data.starts,
      lengths: data.lengths,
    };
    if (entityIndexWaiter) {
      const resolve = entityIndexWaiter;
      entityIndexWaiter = null;
      resolve(pendingEntityIndex);
    }
    return;
  }
  if (data.type !== 'parse') return;

  const { id, source, yieldIntervalMs, deferPropertyAtomIndex, waitForEntityIndex } = data;
  const startedAt = performance.now();

  try {
    // The SAB itself is shared by reference — both this worker and the
    // main thread (and the geometry workers) hold views of the same bytes.
    // We never transfer or clone it. Runtimes that reject TextDecoder over
    // SAB views (e.g. Firefox's timing-attack mitigation) are filtered out
    // by the wrapper before this worker is even spawned.
    //
    // Initialise the WASM scanner up front. `parseColumnar` prefers the
    // WASM scan when `wasmApi` is supplied (5–10× faster on huge files —
    // a 14 M-entity, 986 MB file goes from ~28 s of JS tokenising to ~5 s
    // of Rust+SIMD). We start init BEFORE awaiting the entity index so the
    // module compile happens in parallel with the host's pre-pass.
    const wasmApiPromise = ensureWasmScanApi();

    // If the host promised to ship an entity index, hold here until it
    // arrives. The streaming geometry pre-pass already walked the file
    // once and built the same index — reusing it skips a duplicate
    // 6–10 s scan inside this worker.
    let preScanned: NonNullable<typeof pendingEntityIndex> | null = null;
    if (waitForEntityIndex) {
      // 60 s is generous — pre-pass on a 1 GB file completes in ~5 s.
      // The fallback path (own WASM scan) costs ~10 s, so an over-long
      // wait here would hurt more than it helps. The host gates this
      // flag to paths that actually emit, so timeouts shouldn't fire
      // in practice.
      preScanned = await awaitEntityIndex(60_000);
    } else {
      preScanned = takeEntityIndex();
    }

    const wasmApi = await wasmApiPromise;
    const parser = new IfcParser();
    // `source` is the SAB-backed payload — `parseColumnar` accepts
    // `ArrayBuffer | SharedArrayBuffer` so no cast is needed.
    const dataStore: IfcDataStore = await parser.parseColumnar(source, {
      // Inside a worker, spawning another worker for scan is wasteful.
      disableWorkerScan: true,
      wasmApi,
      yieldIntervalMs,
      deferPropertyAtomIndex,
      preScannedEntityIndex: preScanned ?? undefined,
      onProgress: (progress) => {
        postOutput({ type: 'progress', id, progress });
      },
      onDiagnostic: (message) => {
        postOutput({ type: 'diagnostic', id, message });
      },
      onSpatialReady: (partialStore) => {
        try {
          const { payload } = toTransport(partialStore);
          // We intentionally do NOT transfer the partial typed-array
          // buffers. The worker keeps using them for the rest of the parse
          // (entityIndex.byId.get(...) etc. all read from these arrays).
          // Structured-clone copy is acceptable for the partial because
          // the hierarchy panel is small relative to the full store.
          postOutput({ type: 'partial-store', id, payload });
        } catch (err) {
          postOutput({
            type: 'error',
            id,
            message: `partial-store serialization failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      },
    });

    const { payload, transfers } = toTransport(dataStore);
    const jsHeapBytes = readJsHeapBytes();
    const uaMemoryBytes = await readUaMemoryBytes();
    const memory: ParserMemorySnapshot = {
      jsHeapBytes,
      uaMemoryBytes,
      transportBytes: transportByteSize(payload),
      sourceBytes: source.byteLength,
      parseTimeMs: performance.now() - startedAt,
    };

    postOutput({ type: 'complete', id, payload, memory }, transfers);
  } catch (err) {
    postOutput({
      type: 'error',
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
