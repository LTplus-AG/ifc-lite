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

self.onmessage = async (event: MessageEvent<ParserWorkerInputMessage>) => {
  const { type, id } = event.data;
  if (type !== 'parse') return;

  const { source, yieldIntervalMs, deferPropertyAtomIndex } = event.data;
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
    // of Rust+SIMD).
    const wasmApi = await ensureWasmScanApi();
    const parser = new IfcParser();
    const dataStore: IfcDataStore = await parser.parseColumnar(source as unknown as ArrayBuffer, {
      // Inside a worker, spawning another worker for scan is wasteful.
      disableWorkerScan: true,
      wasmApi,
      yieldIntervalMs,
      deferPropertyAtomIndex,
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
