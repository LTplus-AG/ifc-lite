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

import type { RemeshConfig, RemeshRequest, RemeshResult } from './remesh-core.js';
import type { RemeshWorkerInbound, RemeshWorkerOutbound } from './remesh-protocol.js';

export interface RemeshClientOptions {
  /** A compiled engine module to instantiate instead of fetching one. */
  wasmModule?: WebAssembly.Module;
  /** Engine binary URL, for hosts whose bundler does not rewrite wasm-bindgen's. */
  wasmUrl?: string;
  /** Worker factory; defaults to the package's own `remesh.worker`. */
  createWorker?: () => Worker;
}

type Pending = { resolve: (result: RemeshResult) => void; reject: (error: Error) => void };

export class RemeshClient {
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 1;
  private disposed = false;

  private constructor(private readonly worker: Worker) {}

  /** Spawn the worker and resolve once its engine is instantiated. */
  static async create(config: RemeshConfig, options: RemeshClientOptions = {}): Promise<RemeshClient> {
    const worker = options.createWorker?.()
      ?? new Worker(new URL('./remesh.worker.ts', import.meta.url), { type: 'module' });
    const client = new RemeshClient(worker);
    try {
      await client.start(config, options);
    } catch (error) {
      client.dispose();
      throw error;
    }
    return client;
  }

  private start(config: RemeshConfig, options: RemeshClientOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent<RemeshWorkerOutbound>) => {
        const message = event.data;
        if (message.type === 'ready') {
          this.worker.onmessage = (next: MessageEvent<RemeshWorkerOutbound>) => this.settle(next.data);
          resolve();
        } else if (message.type === 'init-error') {
          reject(new Error(`Re-mesh engine failed to start: ${message.message}`));
        }
      };
      this.worker.onerror = (event: ErrorEvent) => {
        const error = new Error(`Re-mesh worker failed: ${event.message}`);
        reject(error);
        this.failAll(error);
      };
      this.post({ type: 'init', config, wasmModule: options.wasmModule, wasmUrl: options.wasmUrl });
    });
  }

  /**
   * Mesh `request.targets` from `request.buffer`. The buffer's memory is
   * TRANSFERRED to the worker when it spans a whole `ArrayBuffer`, so the
   * caller must not read it afterwards.
   */
  remesh(request: RemeshRequest): Promise<RemeshResult> {
    if (this.disposed) return Promise.reject(new Error('RemeshClient is disposed'));
    const requestId = this.nextRequestId++;
    const { buffer } = request;
    const transfer = buffer.buffer instanceof ArrayBuffer
      && buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength
      ? [buffer.buffer]
      : [];
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.post({ type: 'remesh', requestId, request }, transfer);
    });
  }

  /** Change the load toggles; applies to every request sent after this call. */
  setConfig(config: RemeshConfig): void {
    if (this.disposed) return;
    this.post({ type: 'config', config });
  }

  /** Terminate the worker and reject whatever is still in flight. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.failAll(new Error('RemeshClient is disposed'));
  }

  private post(message: RemeshWorkerInbound, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private settle(message: RemeshWorkerOutbound): void {
    if (message.type !== 'result' && message.type !== 'error') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.type === 'result') pending.resolve(message.result);
    else pending.reject(new Error(`Re-mesh failed: ${message.message}`));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
