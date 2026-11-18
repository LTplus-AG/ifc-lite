/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main-thread handle on one long-lived re-mesh worker (#6232 WP1).
 *
 * One client per open Model workspace: `create` spawns the worker and waits
 * until its wasm engine is up, `remesh` meshes a subgraph buffer in the
 * model's load frame, and `dispose` terminates the worker and rejects any
 * request still in flight. Requests are answered in the order they were sent.
 */

import type { RemeshConfig, RemeshRequest, RemeshResult, StyleWire } from './remesh-core.js';
import type { RemeshWorkerInbound, RemeshWorkerOutbound } from './remesh-protocol.js';
import { createWorkerRpc, type RpcReply, type WorkerRpc } from '@ifc-lite/wasm-lifecycle';
import { restashWasmPanicLocation } from '../wasm-panic-forward.js';

export interface RemeshClientOptions {
  /** A compiled engine module to instantiate instead of fetching one. */
  wasmModule?: WebAssembly.Module;
  /** Engine binary URL, for hosts whose bundler does not rewrite wasm-bindgen's. */
  wasmUrl?: string;
  /** Worker factory; defaults to the package's own `remesh.worker`. */
  createWorker?: () => Worker;
  /**
   * How long one request may take before the client gives up on the worker.
   * A wasm call cannot be interrupted, so a request past this deadline kills
   * the worker and the client; the caller creates a new one. Default 30 s.
   * Clamped to 2^31-1 ms; `0`, negative, `NaN` or `Infinity` means no deadline.
   */
  requestTimeoutMs?: number;
  /**
   * How long `create` waits for the worker to report its engine ready (wasm
   * fetch + compile + instantiate) before it terminates the worker and
   * rejects. Separate from `requestTimeoutMs` so a fail-fast request deadline
   * does not also cut off a slow engine start. Default 120 s. Clamped to
   * 2^31-1 ms; `0`, negative, `NaN` or `Infinity` means no deadline.
   */
  startTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 120_000;

function decodeOutbound(data: unknown): RpcReply<number> | undefined {
  const message = data as RemeshWorkerOutbound;
  if (message.type === 'result') return { id: message.requestId, value: message.result };
  if (message.type === 'style-wire') return { id: message.requestId, value: message.wire };
  if (message.type === 'error') {
    restashWasmPanicLocation(globalThis, message.wasmPanicLocation, message.wasmPanicAt, message.message);
    return { id: message.requestId, error: new Error(`Re-mesh failed: ${message.message}`) };
  }
  return undefined;
}

export class RemeshClient {
  private constructor(private readonly rpc: WorkerRpc<number>) {}

  /** False once disposed or once its worker failed; create a new client then. */
  get alive(): boolean {
    return this.rpc.alive;
  }

  /**
   * Spawn the worker and resolve once its engine is instantiated. Every way
   * init can fail (init-error, worker error, unreadable message, a throwing
   * post, no answer within `startTimeoutMs`) rejects and kills the worker.
   */
  static async create(config: RemeshConfig, options: RemeshClientOptions = {}): Promise<RemeshClient> {
    const worker = options.createWorker?.()
      ?? new Worker(new URL('./remesh.worker.ts', import.meta.url), { type: 'module' });
    const rpc = createWorkerRpc({
      worker,
      label: 'Re-mesh worker',
      decode: decodeOutbound,
      // A wasm call cannot be interrupted: a request past its deadline kills the worker.
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      onRequestTimeout: 'kill',
    });
    await rpc.start<void>({
      post: () => worker.postMessage(
        { type: 'init', config, wasmModule: options.wasmModule, wasmUrl: options.wasmUrl } satisfies RemeshWorkerInbound,
        [],
      ),
      accept: (data) => {
        const message = data as RemeshWorkerOutbound;
        if (message.type === 'ready') return { ready: undefined };
        if (message.type === 'init-error') {
          restashWasmPanicLocation(globalThis, message.wasmPanicLocation, message.wasmPanicAt, message.message);
          return { error: new Error(`Re-mesh engine failed to start: ${message.message}`) };
        }
        return undefined;
      },
      timeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      timeoutError: () => new Error(`Re-mesh worker did not start within ${options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS} ms`),
    });
    return new RemeshClient(rpc);
  }

  /**
   * Mesh `request.targets` from `request.buffer`. The buffer's memory is
   * TRANSFERRED to the worker when it spans a whole `ArrayBuffer`, so the
   * caller must not read it afterwards.
   */
  remesh(request: RemeshRequest): Promise<RemeshResult> {
    const { buffer } = request;
    const transfer = buffer.buffer instanceof ArrayBuffer
      && buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
      ? [buffer.buffer]
      : [];
    return this.rpc.request<RemeshResult>(
      (requestId): RemeshWorkerInbound => ({ type: 'remesh', requestId, request }),
      { transfer },
    );
  }

  /**
   * The style wire a whole-file pre-pass resolves for `source`, for a model
   * whose load did not keep one. The source is COPIED to the worker (the
   * caller's model still owns it), and the pre-pass cache is released after.
   */
  styleWire(source: Uint8Array): Promise<StyleWire> {
    return this.rpc.request<StyleWire>((requestId): RemeshWorkerInbound => ({ type: 'style-wire', requestId, source }));
  }

  /** Change the load toggles; applies to every request sent after this call. */
  setConfig(config: RemeshConfig): void {
    this.rpc.notify({ type: 'config', config } satisfies RemeshWorkerInbound);
  }

  /** Terminate the worker and reject whatever is still in flight. Idempotent. */
  dispose(): void {
    this.rpc.dispose(new Error('RemeshClient is disposed'));
  }
}
