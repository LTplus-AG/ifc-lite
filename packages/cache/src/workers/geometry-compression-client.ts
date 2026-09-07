/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CompressionRequest, CompressionResponse } from './geometry-compression-protocol.js';

type StoredChunk = { bytes: Uint8Array<ArrayBuffer>; compressed: boolean };
export interface CompressionWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: CompressionRequest, transfers: ArrayBuffer[]): void;
  terminate(): void;
}

/** Private per-write owner. The existing builder bounds requests to four chunks. */
export class GeometryCompressionSession {
  private worker?: CompressionWorkerPort;
  private nextId = 0;
  private failure?: Error;
  private readonly pending = new Map<number, {
    length: number; resolve: (value: StoredChunk) => void; reject: (error: Error) => void;
  }>();

  constructor(private readonly createWorker: () => CompressionWorkerPort = () =>
    new Worker(new URL('./geometry-compression.worker.js', import.meta.url), { type: 'module' })) {}

  compress(raw: Uint8Array<ArrayBuffer>): Promise<StoredChunk> {
    if (this.failure) return Promise.reject(this.failure);
    if (raw.byteOffset !== 0 || raw.byteLength !== raw.buffer.byteLength) {
      return Promise.reject(new Error('Geometry compression requires an owned whole buffer'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { length: raw.byteLength, resolve, reject });
      try {
        if (!this.worker) {
          this.worker = this.createWorker();
          this.worker.onmessage = event => this.receive(event.data);
          this.worker.onerror = event => {
            event.preventDefault();
            this.fail(new Error(`Geometry compression worker failed: ${event.message}`));
          };
          this.worker.onmessageerror = () => this.fail(new Error('Geometry compression response could not be decoded'));
        }
        this.worker.postMessage({ id, buffer: raw.buffer }, [raw.buffer]);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.fail(new Error('Geometry compression session closed'));
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== 'object') {
      this.fail(new Error('Invalid geometry compression response'));
      return;
    }
    const response = value as Partial<CompressionResponse>;
    const pending = typeof response.id === 'number' ? this.pending.get(response.id) : undefined;
    if (!pending) {
      this.fail(new Error('Unknown geometry compression response id'));
      return;
    }
    if ('error' in response) {
      this.fail(new Error(`Geometry compression failed: ${String(response.error)}`));
      return;
    }
    if (!('buffer' in response) || !(response.buffer instanceof ArrayBuffer)
      || typeof response.compressed !== 'boolean'
      || (response.compressed && response.buffer.byteLength === 0)
      || (response.compressed ? response.buffer.byteLength >= pending.length
        : response.buffer.byteLength !== pending.length)) {
      this.fail(new Error('Invalid geometry compression result length or flags'));
      return;
    }
    this.pending.delete(response.id!);
    pending.resolve({ bytes: new Uint8Array(response.buffer), compressed: response.compressed });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
