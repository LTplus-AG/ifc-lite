/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CompressionRequest, CompressionResponse, DecodeRequest, InflateRequest } from './geometry-compression-protocol.js';
import type { MeshData } from '@ifc-lite/geometry';
import { unpackDecodedChunk } from './decoded-chunk-transfer.js';
import { accountWorkerMessages } from '@ifc-lite/load-trace';

/** The worker's codec threw on a request (the data, or the worker's codec environment), as opposed to the worker itself failing. */
export class WorkerCodecError extends Error {
  override name = 'WorkerCodecError';
}

type StoredChunk = { bytes: Uint8Array<ArrayBuffer>; compressed: boolean };
export interface CompressionWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: CompressionRequest | InflateRequest | DecodeRequest, transfers: ArrayBuffer[]): void;
  terminate(): void;
}

/** Private per-write owner. The existing builder bounds requests to four chunks. */
export class GeometryCompressionSession {
  private worker?: CompressionWorkerPort;
  private nextId = 0;
  private failure?: Error;
  private readonly pending = new Map<number, {
    /** Compress: the raw length. Inflate: the raw length the chunk directory declares. */
    length: number; inflate: boolean; resolve: (value: StoredChunk) => void; reject: (error: Error) => void;
  }>();

  private readonly pendingDecode = new Map<number, {
    meshCount: number; pool: readonly Uint32Array[] | undefined; resolve: (meshes: MeshData[]) => void; reject: (error: Error) => void;
  }>();
  /** The pool this session's worker holds (sent with its first decode). */
  private sentPool: readonly Uint32Array[] | undefined;

  constructor(private readonly createWorker: () => CompressionWorkerPort = () =>
    new Worker(new URL('./geometry-compression.worker.js', import.meta.url), { type: 'module' })) {}

  compress(raw: Uint8Array<ArrayBuffer>): Promise<StoredChunk> {
    if (this.failure) return Promise.reject(this.failure); // the session's own failure comes first, as before
    if (raw.byteOffset !== 0 || raw.byteLength !== raw.buffer.byteLength) {
      return Promise.reject(new Error('Geometry compression requires an owned whole buffer'));
    }
    return this.request(raw.buffer, false, raw.byteLength);
  }

  /**
   * Inflate one stored deflate-raw chunk off the calling thread. `stored` is
   * copied (a view into the cache entry cannot be transferred); the result must
   * be exactly `rawLength` bytes, the chunk directory's uncompressed length.
   */
  inflate(stored: Uint8Array, rawLength: number): Promise<Uint8Array<ArrayBuffer>> {
    return this.request(stored.slice().buffer, true, rawLength).then((chunk) => chunk.bytes);
  }

  /**
   * Inflate (when `compressed`) and decode one stored chunk off the calling thread. `stored` is
   * copied; the reply transfers the mesh arrays, and pool references resolve to `pool`'s own arrays.
   */
  decode(stored: Uint8Array, compressed: boolean, rawLength: number, meshCount: number, version: number, pool?: readonly Uint32Array[]): Promise<MeshData[]> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pendingDecode.set(id, { meshCount, pool, resolve, reject });
      const buffer = stored.slice().buffer;
      const samePool = pool !== undefined && pool === this.sentPool;
      try {
        this.start().postMessage({ id, op: 'decode', buffer, compressed, rawLength, meshCount, version,
          ...(pool && !samePool ? { pool: [...pool] } : {}), ...(samePool ? { samePool: true as const } : {}) }, [buffer]);
        if (pool) this.sentPool = pool;
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private request(buffer: ArrayBuffer, inflate: boolean, length: number): Promise<StoredChunk> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { length, inflate, resolve, reject });
      try {
        this.start().postMessage(inflate ? { id, op: 'inflate', buffer } : { id, buffer }, [buffer]);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Start the worker now (it boots while other work runs); requests start it otherwise. */
  start(): CompressionWorkerPort {
    if (this.failure) throw this.failure;
    if (!this.worker) {
      this.worker = accountWorkerMessages(this.createWorker(), 'cacheCompression'); // #6957
      this.worker.onmessage = event => this.receive(event.data);
      this.worker.onerror = event => {
        event.preventDefault();
        this.fail(new Error(`Geometry compression worker failed: ${event.message}`));
      };
      this.worker.onmessageerror = () => this.fail(new Error('Geometry compression response could not be decoded'));
    }
    return this.worker;
  }

  close(): void {
    this.fail(new Error('Geometry compression session closed'));
  }

  /** End the session: the worker stops and every pending request rejects with `error`. */
  abort(error: Error): void {
    this.fail(error);
  }

  /** True once the session ended (closed, aborted or its worker failed). */
  get failed(): boolean { return this.failure !== undefined; }

  private receive(value: unknown): void {
    if (!value || typeof value !== 'object') {
      this.fail(new Error('Invalid geometry compression response'));
      return;
    }
    const response = value as Partial<CompressionResponse>;
    const decoding = typeof response.id === 'number' ? this.pendingDecode.get(response.id) : undefined;
    if (decoding) {
      this.pendingDecode.delete(response.id!);
      // A decode's error is about that chunk's data (the handler caught it): reject it alone.
      if ('error' in response) { decoding.reject(new WorkerCodecError(`Chunk decode failed in the worker: ${String(response.error)}`)); return; }
      try {
        decoding.resolve(unpackDecodedChunk((response as { meshes?: unknown }).meshes, (response as { poolRefs?: unknown }).poolRefs, decoding.meshCount, decoding.pool));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        decoding.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    const pending = typeof response.id === 'number' ? this.pending.get(response.id) : undefined;
    if (!pending) {
      this.fail(new Error('Unknown geometry compression response id'));
      return;
    }
    if ('error' in response) {
      // An inflate's codec error is about that chunk's data: reject it alone and keep the worker
      // (its handler caught the throw). A compress error still ends the session, as before.
      if (pending.inflate) {
        this.pending.delete(response.id!);
        pending.reject(new WorkerCodecError(`Chunk inflate failed in the worker: ${String(response.error)}`));
        return;
      }
      this.fail(new WorkerCodecError(`Geometry compression failed: ${String(response.error)}`));
      return;
    }
    if (!('buffer' in response) || !(response.buffer instanceof ArrayBuffer)
      || typeof response.compressed !== 'boolean'
      || (pending.inflate && (response.compressed || response.buffer.byteLength !== pending.length))
      || (!pending.inflate && response.compressed && response.buffer.byteLength === 0)
      || (!pending.inflate && (response.compressed ? response.buffer.byteLength >= pending.length
        : response.buffer.byteLength !== pending.length))) {
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
    for (const pending of this.pendingDecode.values()) pending.reject(error);
    this.pendingDecode.clear();
  }
}
