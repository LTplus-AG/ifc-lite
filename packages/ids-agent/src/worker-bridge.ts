/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ModelBridge` over a message port (IDS-078). The model data lives in the
 * model-loop worker (`04-model-loop.md` §7); the agent runs on the main
 * thread or in Node. `createWorkerModelBridge(port)` is the agent side,
 * `serveModelBridge(port, impl)` the worker side. Requests carry an id;
 * a cancelled request posts `cancel` and resolves as an abort error, and a
 * late answer to it is dropped.
 *
 * Only the `ModelBridge` methods cross the port, with structured-clone data.
 */

import type { ModelBridge } from './bridges.js';

type Method = 'stats' | 'count' | 'distinctValues' | 'infer' | 'coverage';

export type BridgeRequest = { type: 'call'; id: number; method: Method; arg: unknown } | { type: 'cancel'; id: number };
export type BridgeResponse = { type: 'result'; id: number; value: unknown } | { type: 'error'; id: number; message: string };

/** The subset of `MessagePort` / `Worker` the bridge needs. */
export interface BridgePort {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

function isResponse(value: unknown): value is BridgeResponse {
  return typeof value === 'object' && value !== null && 'type' in value && 'id' in value
    && ((value as { type: unknown }).type === 'result' || (value as { type: unknown }).type === 'error');
}

function isRequest(value: unknown): value is BridgeRequest {
  return typeof value === 'object' && value !== null && 'type' in value && 'id' in value
    && ((value as { type: unknown }).type === 'call' || (value as { type: unknown }).type === 'cancel');
}

export function createWorkerModelBridge(port: BridgePort): ModelBridge & { dispose(): void } {
  let next = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listener = (event: { data: unknown }) => {
    if (!isResponse(event.data)) return;
    const entry = pending.get(event.data.id);
    if (!entry) return; // a late answer to a cancelled request
    pending.delete(event.data.id);
    if (event.data.type === 'result') entry.resolve(event.data.value);
    else entry.reject(new Error(event.data.message));
  };
  port.addEventListener('message', listener);
  const call = <T>(method: Method, arg: unknown, signal: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    const id = ++next;
    const onAbort = () => {
      pending.delete(id);
      port.postMessage({ type: 'cancel', id } satisfies BridgeRequest);
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // The worker answers with the value of `method`, whose type is `T`.
    pending.set(id, {
      resolve: (v) => { signal.removeEventListener('abort', onAbort); resolve(v as T); },
      reject: (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    });
    port.postMessage({ type: 'call', id, method, arg } satisfies BridgeRequest);
  });
  return {
    stats: (signal) => call('stats', null, signal),
    count: (query, signal) => call('count', query, signal),
    distinctValues: (query, signal) => call('distinctValues', query, signal),
    infer: (query, signal) => call('infer', query, signal),
    coverage: (query, signal) => call('coverage', query, signal),
    dispose() {
      port.removeEventListener('message', listener);
      for (const entry of pending.values()) entry.reject(new Error('bridge disposed'));
      pending.clear();
    },
  };
}

/** Worker side: answer bridge requests from `impl`. Returns a function that stops serving. */
export function serveModelBridge(port: BridgePort, impl: ModelBridge): () => void {
  const running = new Map<number, AbortController>();
  const listener = (event: { data: unknown }) => {
    const request = event.data;
    if (!isRequest(request)) return;
    if (request.type === 'cancel') { running.get(request.id)?.abort(); running.delete(request.id); return; }
    const controller = new AbortController();
    running.set(request.id, controller);
    const s = controller.signal;
    // Each method receives the argument the agent side sent for it.
    const work: Promise<unknown> = request.method === 'stats' ? impl.stats(s)
      : request.method === 'count' ? impl.count(request.arg as Parameters<ModelBridge['count']>[0], s)
        : request.method === 'distinctValues' ? impl.distinctValues(request.arg as Parameters<ModelBridge['distinctValues']>[0], s)
          : request.method === 'infer' ? impl.infer(request.arg as Parameters<ModelBridge['infer']>[0], s)
            : impl.coverage(request.arg as Parameters<ModelBridge['coverage']>[0], s);
    work.then(
      (value) => { if (running.delete(request.id)) port.postMessage({ type: 'result', id: request.id, value } satisfies BridgeResponse); },
      (error: unknown) => {
        if (running.delete(request.id)) {
          port.postMessage({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) } satisfies BridgeResponse);
        }
      },
    );
  };
  port.addEventListener('message', listener);
  return () => {
    port.removeEventListener('message', listener);
    for (const c of running.values()) c.abort();
    running.clear();
  };
}
