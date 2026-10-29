/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RETAINED_MAX_SOURCE_BYTES, RetainedHostError } from './retained-protocol';
import type { RetainedHostEvent, RetainedHostRequest, RetainedHostResponse } from './retained-protocol';

/** Small Worker boundary so protocol fixtures can observe termination. */
export interface RetainedWorker {
  postMessage(message: RetainedHostRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<RetainedHostResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
interface ActiveRun {
  id: number;
  candidates: Uint32Array;
  received: Set<number>;
  queue: RetainedHostEvent[];
  done: boolean;
  error?: RetainedHostError;
  wake?: () => void;
}

/** One lazy, warm host per tab. No engine import or Worker until iteration. */
export class RetainedClient {
  private worker?: RetainedWorker;
  private active?: ActiveRun;
  private serial = 0;
  private idle?: ReturnType<typeof setTimeout>;
  private readonly pageHide = () => this.unload();
  constructor(
    private readonly createWorker: () => RetainedWorker = () =>
      new Worker(new URL('./retained.worker.ts', import.meta.url), { type: 'module' }),
    private readonly idleMs = 5 * 60 * 1000,
    private readonly lifecycle: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | undefined =
      typeof window === 'undefined' ? undefined : window,
  ) {}

  async *run(bytes: Uint8Array, options: { ids?: Uint32Array; signal?: AbortSignal } = {}): AsyncGenerator<RetainedHostEvent> {
    if (this.active) throw new RetainedHostError('busy', 'A retained model is already running');
    if (bytes.byteLength > RETAINED_MAX_SOURCE_BYTES) {
      throw new RetainedHostError('source_too_large', 'Retained geometry supports sources up to 256 MiB');
    }
    if (options.signal?.aborted) return;
    clearTimeout(this.idle);
    const run: ActiveRun = { id: ++this.serial, candidates: new Uint32Array(), received: new Set(), queue: [], done: false };
    this.active = run;
    const abort = () => this.cancel();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      try {
        if (!this.worker) {
          this.worker = this.createWorker();
          this.lifecycle?.addEventListener('pagehide', this.pageHide);
          this.worker.onmessage = ({ data }) => this.receive(data);
          this.worker.onerror = (event) => {
            event.preventDefault();
            this.fail(new RetainedHostError('worker_crash', event.message || 'Retained Worker crashed'));
          };
          this.worker.onmessageerror = () => this.fail(new RetainedHostError('worker_crash', 'Retained Worker message could not be decoded'));
        }
        // Deliberately clone, never transfer the loader's source buffer.
        this.worker.postMessage({ runId: run.id, bytes, options: { ids: options.ids, detail: 'view' } });
      } catch (error) {
        this.fail(new RetainedHostError('startup', error instanceof Error ? error.message : String(error)));
      }
      while (true) {
        while (run.queue.length) yield run.queue.shift()!;
        if (run.error) throw run.error;
        if (run.done) return;
        await new Promise<void>((resolve) => { run.wake = resolve; });
      }
    } finally {
      options.signal?.removeEventListener('abort', abort);
      // Iterator abandonment must release the nested SMLib Worker as well.
      if (!run.done) this.cancel();
      if (this.active === run) this.active = undefined;
      if (this.worker) this.idle = setTimeout(() => this.stopWorker(), this.idleMs);
    }
  }

  cancel(): void {
    this.stopWorker();
    const run = this.active;
    if (!run || run.done) return;
    for (const expressId of run.candidates) {
      if (!run.received.has(expressId)) run.queue.push({ kind: 'cancelled', expressId, code: 'cancelled' });
    }
    run.queue.push({ kind: 'complete', cancelled: true });
    run.done = true;
    run.wake?.();
  }

  /** Called when the retained model is unloaded; pagehide also uses this.
   * Releases the host and its idle timer directly, not only through cancel(). */
  unload(): void {
    this.cancel();
    this.stopWorker();
  }

  private stopWorker(): void {
    clearTimeout(this.idle);
    this.lifecycle?.removeEventListener('pagehide', this.pageHide);
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
      this.worker = undefined;
    }
  }

  private fail(error: RetainedHostError): void {
    this.stopWorker();
    if (!this.active || this.active.done) return;
    this.active.error = error;
    this.active.done = true;
    this.active.wake?.();
  }

  private receive(message: RetainedHostResponse): void {
    const run = this.active;
    if (!run || run.done || message.runId !== run.id) return;
    if (message.kind === 'error') {
      this.fail(new RetainedHostError(message.code, message.message));
      return;
    }
    if (message.kind === 'start') run.candidates = message.candidateIds;
    if (message.kind === 'published' || message.kind === 'refused') run.received.add(message.expressId);
    if (message.kind === 'published') {
      for (const product of message.instanceProducts ?? []) run.received.add(product.expressId);
    }
    if (message.kind === 'complete') run.done = true;
    run.queue.push(message);
    run.wake?.();
  }
}
