// SPDX-License-Identifier: MPL-2.0
// Raw handles are valid only alongside this client and its current incarnation.
export class SmlibWorkerTransport {
  #worker;
  #pending = new Map();
  #next = 0;
  #generation = 0;
  #incarnation;
  #disposed = false;
  constructor({ workerUrl = new URL('./worker.mjs', import.meta.url), timeout = 30000, maxPending = 8 } = {}) {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('invalid timeout');
    if (!Number.isSafeInteger(maxPending) || maxPending <= 0) throw new Error('invalid pending limit');
    this.maxPending = maxPending;
    this.workerUrl = workerUrl;
    this.timeout = timeout;
    this.#start();
  }
  get incarnation() { return this.#incarnation; }
  #start() {
    this.#generation++;
    // Object identity distinguishes both different clients and restarts.
    const incarnation = Object.freeze({ generation: this.#generation });
    const worker = new Worker(this.workerUrl, { type: 'module' });
    this.#incarnation = incarnation;
    this.#worker = worker;
    worker.onmessage = ({ data }) => {
      if (this.#worker !== worker) return;
      if (data.fatal) { this.#poison(new Error(data.fatal)); return; }
      const pending = this.#pending.get(data.id);
      if (!pending || !Array.isArray(data.frames) || data.frames.length !== pending.count ||
          data.frames.some((frame) => !(frame instanceof ArrayBuffer) || frame.byteLength < 12 ||
            frame.byteLength > 4096)) {
        this.#poison(new Error('invalid worker response')); return;
      }
      clearTimeout(pending.timer);
      this.#pending.delete(data.id);
      pending.resolve(data.frames);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.#worker === worker) this.#poison(new Error(event.message || 'worker failed'));
    };
    worker.onmessageerror = () => {
      if (this.#worker === worker) this.#poison(new Error('unreadable worker response'));
    };
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
