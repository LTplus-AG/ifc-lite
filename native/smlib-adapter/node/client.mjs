// SPDX-License-Identifier: MPL-2.0
import { Worker } from 'node:worker_threads';
// Raw handles are valid only alongside this client and its current incarnation.
// Keep the browser client's frame protocol, admission and lifetime semantics.
export class SmlibWorkerTransport {
  #worker;
  #pending = new Map();
  #next = 0;
  #generation = 0;
  #incarnation;
  #disposed = false;
  #heap = new BigUint64Array(new SharedArrayBuffer(8));
  constructor({ workerUrl = '/smlib/worker.mjs', timeout = 30000, maxPending = 8 } = {}) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('invalid timeout');
    if (!Number.isSafeInteger(maxPending) || maxPending <= 0) throw new Error('invalid pending limit');
    this.maxPending = maxPending;
    this.workerUrl = workerUrl;
    this.timeout = timeout;
    this.#start();
  }
  get incarnation() { return this.#incarnation; }
  // Sampled worker JS heap, across incarnations; not WASM linear memory or RSS.
  get peakHeapBytes() { return Number(Atomics.load(this.#heap, 0)); }
  #start() {
    this.#generation++;
    // Object identity distinguishes both different clients and restarts.
    const incarnation = Object.freeze({ generation: this.#generation });
    const workerUrl = this.workerUrl === '/smlib/worker.mjs'
      ? new URL('../worker.mjs', import.meta.url).href : new URL(this.workerUrl).href;
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { workerUrl, heap: this.#heap.buffer },
    });
    this.#incarnation = incarnation;
    this.#worker = worker;
    worker.on('message', (data) => {
      if (this.#worker !== worker) return;
      if (data?.fatal) { this.#poison(new Error(data.fatal)); return; }
      if (!data) { this.#poison(new Error('invalid worker response')); return; }
      const pending = this.#pending.get(data.id);
      if (!pending || !Array.isArray(data.frames) || data.frames.length !== pending.count ||
          data.frames.some((frame) => !(frame instanceof ArrayBuffer) || frame.byteLength < 12 ||
            frame.byteLength > 4096)) {
        this.#poison(new Error('invalid worker response')); return;
      }
      clearTimeout(pending.timer);
      this.#pending.delete(data.id);
      pending.resolve(data.frames);
    });
    worker.on('error', (error) => {
      if (this.#worker === worker) this.#poison(error);
    });
    worker.on('messageerror', () => {
      if (this.#worker === worker) this.#poison(new Error('unreadable worker response'));
    });
    worker.on('exit', (code) => {
      if (this.#worker === worker) this.#poison(new Error(`worker exited (${code})`));
    });
  }
  #poison(error) {
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#incarnation = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
  // Retire only the captured owner; stale cleanup cannot kill a replacement.
  retire(incarnation) {
    if (incarnation !== undefined && incarnation === this.#incarnation) {
      this.#poison(new Error('worker incarnation retired'));
    }
  }
  // Ownership transfers immediately; successful responses own their copied bytes.
  batch(frames, incarnation) {
    if (this.#disposed || !this.#worker) return Promise.reject(new Error('worker unavailable'));
    if (incarnation !== this.incarnation) return Promise.reject(new Error('stale worker incarnation'));
    if (!Array.isArray(frames) || frames.length === 0 || frames.length > 256 ||
        new Set(frames).size !== frames.length || frames.some((frame) => !(frame instanceof ArrayBuffer) || frame.byteLength < 12 || frame.byteLength > 4096)) {
      return Promise.reject(new Error('invalid frame batch'));
    }
    if (this.#pending.size >= this.maxPending) return Promise.reject(Object.assign(new Error('pending batch limit exceeded'), { submitted: false }));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#poison(new Error('worker deadline exceeded')), this.timeout);
      this.#pending.set(id, { resolve, reject, timer, count: frames.length });
      try { this.#worker.postMessage({ id, frames }, frames); }
      catch (error) { this.#poison(error); }
    });
  }
  restart() {
    if (this.#disposed) throw new Error('transport disposed');
    this.#poison(new Error('worker restarted; retained handles invalidated'));
    this.#start();
    return this.incarnation;
  }
  dispose() {
    this.#disposed = true;
    this.#poison(new Error('transport disposed'));
  }
}
