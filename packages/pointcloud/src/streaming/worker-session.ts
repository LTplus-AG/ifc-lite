/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The decode worker's protocol over the shared worker RPC (`@ifc-lite/wasm-lifecycle`). */

import { createWorkerRpc, type RpcReply, type WorkerRpc } from '@ifc-lite/wasm-lifecycle';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

/** Variants that need a response (open / next). */
type RequestWithReply = Extract<WorkerRequest, { requestId: number }>;

function decodeResponse(data: unknown): RpcReply<number> | undefined {
  const msg = data as WorkerResponse;
  if (!('requestId' in msg)) return undefined;
  if (msg.kind === 'error') return { id: msg.requestId, error: new Error(msg.message) };
  return { id: msg.requestId, value: msg };
}

/**
 * @internal Shared with the COPC client.
 *
 * Dead latch from `createWorkerRpc`: the first worker `error` /
 * `messageerror` wins, terminates the worker, rejects every pending request
 * and makes later requests reject at once. A crashed or OOM-killed worker
 * otherwise leaves every open/next/copc-* promise pending forever. `onDeath`
 * lets the shared-session cache evict it.
 */
export class WorkerSession {
  private readonly rpc: WorkerRpc<number>;

  constructor(worker: Worker) {
    this.rpc = createWorkerRpc({ worker, label: 'Point-cloud decode worker', decode: decodeResponse });
  }

  /** False once the worker died; a new session (and worker) is needed then. */
  get alive(): boolean {
    return this.rpc.alive;
  }

  /** Run `listener` once when the worker dies (immediately if it already has). */
  onDeath(listener: (reason: Error) => void): void {
    this.rpc.onDeath(listener);
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
    return this.rpc.request<T>(build, { transfer, onId: onRequestId });
  }

  /** Send a fire-and-forget message (close / abort). No-op once dead. */
  notify(req: WorkerRequest): void {
    this.rpc.notify(req);
  }
}
