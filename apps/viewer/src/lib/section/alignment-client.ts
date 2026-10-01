/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AlignmentRequest, AlignmentResponse } from './alignment-contract';

export type AlignmentWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>;
type Request = AlignmentRequest extends infer T ? T extends AlignmentRequest ? Omit<T, 'id'> : never : never;

/** One owner; deadlines, crashes and teardown reject every outstanding call. */
export class AlignmentClient {
  private worker: AlignmentWorker | null;
  private nextId = 0;
  private pending = new Map<number, {
    resolve: (response: Extract<AlignmentResponse, { ok: true }>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(factory: () => AlignmentWorker = () => new Worker(
    new URL('./alignment.worker.ts', import.meta.url), { type: 'module' }), private timeoutMs = 120_000) {
    this.worker = factory();
    this.worker.onmessage = (event: MessageEvent<AlignmentResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response);
      else { pending.reject(new Error(response.error)); this.close(); }
    };
    this.worker.onerror = () => this.close(new Error('Alignment worker failed'));
    this.worker.onmessageerror = () => this.close(new Error('Alignment worker response could not be decoded'));
  }

  request(request: Request): Promise<Extract<AlignmentResponse, { ok: true }>> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('Alignment evaluator was closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('Alignment evaluation timed out')), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ ...request, id } satisfies AlignmentRequest); }
      catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  close(error = new Error('Alignment evaluation cancelled')): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      if (this.pending.size) {
        // A parse cannot receive messages until it returns. Terminating its
        // realm releases all WASM pages immediately, even on abandonment.
        worker.terminate();
      } else {
        // An idle worker explicitly frees its retained handle, acknowledges,
        // then closes. Bound the acknowledgement wait if its realm crashed.
        let disposed = false;
        const timer = setTimeout(() => finish(), 250);
        const finish = () => { if (disposed) return; disposed = true; clearTimeout(timer); worker.onmessage = null;
          worker.onerror = null; worker.onmessageerror = null; worker.terminate(); };
        worker.onmessage = (event: MessageEvent<unknown>) => {
          if (event.data && typeof event.data === 'object' && 'kind' in event.data
            && event.data.kind === 'disposed') finish();
        };
        worker.onerror = finish; worker.onmessageerror = finish;
        try { worker.postMessage({ kind: 'dispose', id: ++this.nextId } satisfies AlignmentRequest); }
        catch (failure) { console.warn('[alignment] worker disposal message failed', failure); finish(); }
      }
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(error);
    }
    this.pending.clear();
  }
}
