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
   */
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type Pending = { resolve: (value: RemeshResult | StyleWire) => void; reject: (error: Error) => void };

export class RemeshClient {
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 1;
  /** Why the client can no longer answer: disposed, or its worker died. */
  private dead: Error | null = null;

  private constructor(private readonly worker: Worker, private readonly timeoutMs: number) {}

  /** False once disposed or once its worker failed; create a new client then. */
  get alive(): boolean {
    return this.dead === null;
  }

  /** Spawn the worker and resolve once its engine is instantiated. */
  static async create(config: RemeshConfig, options: RemeshClientOptions = {}): Promise<RemeshClient> {
    const worker = options.createWorker?.()
      ?? new Worker(new URL('./remesh.worker.ts', import.meta.url), { type: 'module' });
    const client = new RemeshClient(worker, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
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
          restashWasmPanicLocation(globalThis, message.wasmPanicLocation, message.wasmPanicAt, message.message);
          reject(new Error(`Re-mesh engine failed to start: ${message.message}`));
        }
      };
      this.worker.onerror = (event: ErrorEvent) => {
        const error = new Error(`Re-mesh worker failed: ${event.message}`);
        reject(error);
        this.kill(error);
      };
      this.worker.onmessageerror = () => this.kill(new Error('Re-mesh worker sent a message that could not be read'));
      this.post({ type: 'init', config, wasmModule: options.wasmModule, wasmUrl: options.wasmUrl });
    });
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
    return this.request<RemeshResult>((requestId) => ({ type: 'remesh', requestId, request }), transfer);
  }

  /**
   * The style wire a whole-file pre-pass resolves for `source`, for a model
   * whose load did not keep one. The source is COPIED to the worker (the
   * caller's model still owns it), and the pre-pass cache is released after.
   */
  styleWire(source: Uint8Array): Promise<StyleWire> {
    return this.request<StyleWire>((requestId) => ({ type: 'style-wire', requestId, source }));
  }

  private request<T extends RemeshResult | StyleWire>(
    message: (requestId: number) => RemeshWorkerInbound,
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const requestId = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => this.kill(new Error(`Re-mesh worker did not answer within ${this.timeoutMs} ms`)),
        this.timeoutMs,
      );
      const settle = <V>(fn: (value: V) => void) => (value: V) => { clearTimeout(timer); fn(value); };
      this.pending.set(requestId, {
        resolve: settle(resolve as (value: RemeshResult | StyleWire) => void),
        reject: settle(reject),
      });
      this.post(message(requestId), transfer);
    });
  }

  /** Change the load toggles; applies to every request sent after this call. */
  setConfig(config: RemeshConfig): void {
    if (this.dead) return;
    this.post({ type: 'config', config });
  }

  /** Terminate the worker and reject whatever is still in flight. Idempotent. */
  dispose(): void {
    this.kill(new Error('RemeshClient is disposed'));
  }

  /** Mark the client dead (first reason wins), stop the worker, reject everything pending. */
  private kill(reason: Error): void {
    if (this.dead) return;
    this.dead = reason;
    this.worker.terminate();
    this.failAll(reason);
  }

  private post(message: RemeshWorkerInbound, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private settle(message: RemeshWorkerOutbound): void {
    if (message.type === 'ready' || message.type === 'init-error') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.type === 'result') pending.resolve(message.result);
    else if (message.type === 'style-wire') pending.resolve(message.wire);
    else {
      restashWasmPanicLocation(globalThis, message.wasmPanicLocation, message.wasmPanicAt, message.message);
      pending.reject(new Error(`Re-mesh failed: ${message.message}`));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
