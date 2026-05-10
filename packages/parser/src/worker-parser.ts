/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser-side wrapper around `parser.worker.ts`.
 *
 * Lifecycle:
 *   1. Caller allocates a SharedArrayBuffer for the IFC bytes (so that the
 *      same memory can also be handed to the geometry workers without a
 *      copy).
 *   2. Caller constructs a `WorkerParser` and calls `parseColumnar(sab, …)`.
 *   3. The worker emits `progress`, `diagnostic`, optional `partial-store`,
 *      then `complete` (or `error`). This wrapper resolves the returned
 *      Promise on `complete` and self-terminates afterward.
 *
 * On `partial-store` the wrapper invokes `options.onSpatialReady` so the
 * viewer can render the spatial-hierarchy panel before the full parse
 * completes (matches the in-process callback behavior).
 */

import type { IfcDataStore } from './columnar-parser.js';
import type { ParseOptions } from './index.js';
import {
  fromTransport,
  type DataStoreTransport,
  type ParserMemorySnapshot,
} from './data-store-transport.js';
import type {
  ParserWorkerInputMessage,
  ParserWorkerOutputMessage,
} from './parser.worker.js';

export interface WorkerParserOptions extends ParseOptions {
  /** Override the worker URL. Default: bundler-resolved `parser.worker.ts`. */
  workerUrl?: URL | string;
  /** Optional callback receiving the per-parse memory snapshot at completion. */
  onMemorySnapshot?: (snapshot: ParserMemorySnapshot) => void;
}

/**
 * Probe whether `TextDecoder.decode()` accepts a `SharedArrayBuffer`-backed
 * `Uint8Array` in this realm. Firefox refuses for timing-attack reasons;
 * Chromium (and Safari ≥ 17.4) allow it. Cached because the answer is
 * fixed per-runtime and the probe must allocate an SAB.
 *
 * Used at the start of `parseColumnar` to short-circuit to the in-process
 * fallback when the runtime can't decode SAB strings — every step of
 * `parseColumnar` (`detectSchemaVersion`, `batchExtractGlobalIdAndName`,
 * relationship attribute reads) hits TextDecoder over the source bytes.
 */
let textDecoderAcceptsSabCache: boolean | null = null;

function textDecoderAcceptsSab(): boolean {
  if (textDecoderAcceptsSabCache !== null) return textDecoderAcceptsSabCache;
  if (typeof SharedArrayBuffer === 'undefined') {
    textDecoderAcceptsSabCache = false;
    return false;
  }
  try {
    const sab = new SharedArrayBuffer(8);
    new TextDecoder().decode(new Uint8Array(sab));
    textDecoderAcceptsSabCache = true;
  } catch {
    textDecoderAcceptsSabCache = false;
  }
  return textDecoderAcceptsSabCache;
}

/**
 * Reset the SAB-compat probe cache. Tests only — production callers
 * should never need to invalidate the result because the answer is fixed
 * for the lifetime of the realm.
 */
export function __resetTextDecoderSabProbe(): void {
  textDecoderAcceptsSabCache = null;
}

export class WorkerParser {
  private worker: Worker | null = null;
  private requestCounter = 0;
  private readonly workerUrl: URL | string | null;

  /**
   * Returns true when this runtime can run the parser worker:
   * cross-origin-isolated, `SharedArrayBuffer` available, AND the runtime
   * accepts `TextDecoder.decode(sab-backed view)`. Callers should check
   * this before allocating a SAB and falling through to the in-process
   * parser when it returns false.
   */
  static isSupported(): boolean {
    if (typeof Worker === 'undefined') return false;
    if (typeof SharedArrayBuffer === 'undefined') return false;
    const coi = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    if (coi === false) return false;
    return textDecoderAcceptsSab();
  }

  constructor(options: { workerUrl?: URL | string } = {}) {
    // null = use the default inline URL inside parseColumnar(). Vite's
    // static analyzer only rewrites worker URLs when `new URL(...)` and
    // `new Worker(...)` are inlined together — keeping the URL unresolved
    // here lets us inline the construction below.
    this.workerUrl = options.workerUrl ?? null;
  }

  /**
   * Parse a SharedArrayBuffer-backed IFC payload in a Web Worker.
   *
   * The buffer is shared by reference — the caller may keep a `Uint8Array`
   * view of the same SAB on the main thread (e.g. for the geometry worker
   * pre-pass). The worker neither transfers nor mutates the buffer.
   */
  parseColumnar(source: SharedArrayBuffer, options: WorkerParserOptions = {}): Promise<IfcDataStore> {
    return new Promise((resolve, reject) => {
      // Short-circuit for runtimes (Firefox) that reject TextDecoder over
      // SAB-backed views. The parser would crash on its first
      // `detectSchemaVersion` call inside the worker; surface the
      // incompatibility synchronously so the caller's catch path uses the
      // in-process parser without paying a worker spawn + fast-scan cost.
      if (!textDecoderAcceptsSab()) {
        reject(new Error('parser worker unavailable: TextDecoder rejects SharedArrayBuffer in this runtime'));
        return;
      }

      const id = `parse_${Date.now()}_${++this.requestCounter}`;
      let worker: Worker;
      try {
        // Inlining `new URL(..., import.meta.url)` inside `new Worker(...)`
        // is what makes Vite emit the worker as a separate `.js` chunk.
        // Caller-supplied URLs are honored as-is.
        worker = this.workerUrl !== null
          ? new Worker(this.workerUrl, { type: 'module' })
          : new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' });
      } catch (err) {
        reject(new Error(`Failed to spawn parser worker: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      this.worker = worker;

      // Reusable receiver-side view of the shared bytes. Both the partial
      // and final store on the main thread alias the same SAB.
      const sourceView = new Uint8Array(source);

      const settle = (cleanup: () => void) => {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        cleanup();
      };

      worker.onmessage = (event: MessageEvent<ParserWorkerOutputMessage>) => {
        const msg = event.data;
        if (!msg || msg.id !== id) return;

        switch (msg.type) {
          case 'progress':
            options.onProgress?.(msg.progress);
            return;

          case 'diagnostic':
            options.onDiagnostic?.(msg.message);
            return;

          case 'partial-store': {
            if (!options.onSpatialReady) return;
            try {
              const partial = fromTransport(msg.payload as DataStoreTransport, sourceView);
              options.onSpatialReady(partial);
            } catch (err) {
              // Don't fail the whole parse on partial deserialization
              // — log and continue to the full result.
              console.warn('[WorkerParser] partial-store hydrate failed:', err);
            }
            return;
          }

          case 'complete': {
            try {
              const dataStore = fromTransport(msg.payload as DataStoreTransport, sourceView);
              options.onMemorySnapshot?.(msg.memory);
              settle(() => {
                worker.terminate();
                this.worker = null;
              });
              resolve(dataStore);
            } catch (err) {
              settle(() => {
                worker.terminate();
                this.worker = null;
              });
              reject(new Error(`complete hydrate failed: ${err instanceof Error ? err.message : String(err)}`));
            }
            return;
          }

          case 'error':
            settle(() => {
              worker.terminate();
              this.worker = null;
            });
            reject(new Error(msg.message));
            return;
        }
      };

      worker.onerror = (err) => {
        settle(() => {
          worker.terminate();
          this.worker = null;
        });
        reject(new Error(`Parser worker error: ${err.message || 'unknown failure'}`));
      };

      worker.onmessageerror = () => {
        settle(() => {
          worker.terminate();
          this.worker = null;
        });
        reject(new Error('Parser worker structured-clone error (likely corrupted message)'));
      };

      const input: ParserWorkerInputMessage = {
        type: 'parse',
        id,
        source,
        yieldIntervalMs: options.yieldIntervalMs,
        deferPropertyAtomIndex: options.deferPropertyAtomIndex,
      };
      worker.postMessage(input);
    });
  }

  /** Terminate the worker if running. Safe to call repeatedly. */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
