/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Request/response bookkeeping over one decode worker, with a dead latch. */

import type { WorkerRequest, WorkerResponse } from './protocol.js';

interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (err: Error) => void;
}

/** Variants that need a response (open / next). */
type RequestWithReply = Extract<WorkerRequest, { requestId: number }>;

/**
 * @internal Shared with the COPC client.
 *
 * Dead latch (same contract as the geometry package's `RemeshClient.kill`):
 * the first worker `error` / `messageerror` wins, terminates the worker,
 * rejects every pending request and makes later requests reject at once.
 * A crashed or OOM-killed worker otherwise leaves every open/next/copc-*
 * promise pending forever. `onDeath` lets the shared-session cache evict it.
 */
export class WorkerSession {
  private requests = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private dead: Error | null = null;
  private readonly deathListeners: Array<(reason: Error) => void> = [];

  constructor(public readonly worker: Worker) {
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (!('requestId' in msg)) return;
      const pending = this.requests.get(msg.requestId);
      if (!pending) return;
      this.requests.delete(msg.requestId);
      if (msg.kind === 'error') {
        pending.reject(new Error(msg.message));
      } else {
        pending.resolve(msg);
      }
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      this.fail(new Error(`Point-cloud decode worker failed: ${event.message || 'unknown error'}`));
    });
    worker.addEventListener('messageerror', () => {
      this.fail(new Error('Point-cloud decode worker sent a message that could not be read'));
    });
  }

  /** False once the worker died; a new session (and worker) is needed then. */
  get alive(): boolean {
    return this.dead === null;
  }

  /** Run `listener` once when the worker dies (immediately if it already has). */
  onDeath(listener: (reason: Error) => void): void {
    if (this.dead) listener(this.dead);
    else this.deathListeners.push(listener);
  }

  /**
   * Send a request that expects a single response by `requestId`.
   * `onRequestId` exposes the id so a caller can cancel it later.
   */
  send<T extends WorkerResponse>(
    build: (requestId: number) => RequestWithReply,
    transfer: Transferable[] = [],
    onRequestId?: (requestId: number) => void,
  ): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const requestId = this.nextRequestId++;
    onRequestId?.(requestId);
    const req = build(requestId);
    return new Promise<T>((resolve, reject) => {
      this.requests.set(requestId, {
        resolve: (resp) => resolve(resp as T),
        reject,
      });
      try {
        this.worker.postMessage(req, transfer);
      } catch (err) {
        // The message never left (e.g. DataCloneError): the worker is fine,
        // so fail only this request and drop its entry.
        this.requests.delete(requestId);
        reject(err);
      }
    });
  }

  /** Send a fire-and-forget message (close / abort). No-op once dead. */
  notify(req: WorkerRequest): void {
    if (this.dead) return;
    this.worker.postMessage(req);
  }

  /** First reason wins: stop the worker, reject everything pending, tell listeners. */
  private fail(reason: Error): void {
    if (this.dead) return;
    this.dead = reason;
    this.worker.terminate();
    for (const pending of this.requests.values()) pending.reject(reason);
    this.requests.clear();
    for (const listener of this.deathListeners.splice(0)) listener(reason);
  }
}
