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

import { createWorkerRpc, type RpcReply } from '@ifc-lite/wasm-lifecycle';
import type { ModelBridge } from './bridges.js';

type Method = 'stats' | 'count' | 'distinctValues' | 'infer' | 'coverage';

export type BridgeRequest = { type: 'call'; id: number; method: Method; arg: unknown } | { type: 'cancel'; id: number };
export type BridgeResponse = { type: 'result'; id: number; value: unknown } | { type: 'error'; id: number; message: string };

/** One event from the port: `data` for `message`, `message` for a worker `error`. */
export interface BridgePortEvent {
  data?: unknown;
  message?: string;
}

/**
 * The subset of `MessagePort` / `Worker` the bridge needs. `error` and
 * `messageerror` are only subscribed with `watchErrors`, so an adapter that
 * forwards `message` alone keeps working.
 */
export interface BridgePort {
  postMessage(message: unknown): void;
  addEventListener(type: 'message' | 'messageerror' | 'error', listener: (event: BridgePortEvent) => void): void;
  removeEventListener(type: 'message' | 'messageerror' | 'error', listener: (event: BridgePortEvent) => void): void;
}

export interface WorkerModelBridgeOptions {
  /**
   * Treat the port's `error` / `messageerror` as the worker dying: every
   * pending and later call rejects instead of waiting forever. Pass `true`
   * for a `Worker` or `MessagePort`; leave it off for an adapter that does
   * not distinguish event types.
   */
  watchErrors?: boolean;
}

function isResponse(value: unknown): value is BridgeResponse {
  return typeof value === 'object' && value !== null && 'type' in value && 'id' in value
    && ((value as { type: unknown }).type === 'result' || (value as { type: unknown }).type === 'error');
}

function isRequest(value: unknown): value is BridgeRequest {
  return typeof value === 'object' && value !== null && 'type' in value && 'id' in value
    && ((value as { type: unknown }).type === 'call' || (value as { type: unknown }).type === 'cancel');
}

/**
 * Agent side. Calls reject once the bridge is disposed (or, with
 * `watchErrors`, once the worker died) instead of waiting for an answer that
 * cannot come; the dead latch is `createWorkerRpc`'s.
 */
export function createWorkerModelBridge(port: BridgePort, options: WorkerModelBridgeOptions = {}): ModelBridge & { dispose(): void } {
  const rpc = createWorkerRpc({
    label: 'Model bridge worker',
    post: (message) => port.postMessage(message),
    decode: (data): RpcReply<number> | undefined => {
      if (!isResponse(data)) return undefined;
      return data.type === 'result' ? { id: data.id, value: data.value } : { id: data.id, error: new Error(data.message) };
    },
    close: () => {
      port.removeEventListener('message', onMessage);
      if (options.watchErrors) {
        port.removeEventListener('error', onError);
        port.removeEventListener('messageerror', onMessageError);
      }
    },
  });
  const onMessage = (event: BridgePortEvent) => { rpc.receive(event.data); };
  const onError = (event: BridgePortEvent) => rpc.fail(new Error(`Model bridge worker failed: ${event.message || 'unknown error'}`));
  const onMessageError = () => rpc.fail(new Error('Model bridge worker sent a message that could not be read'));
  port.addEventListener('message', onMessage);
  if (options.watchErrors) {
    port.addEventListener('error', onError);
    port.addEventListener('messageerror', onMessageError);
  }
  // The worker answers with the value of `method`, whose type is `T`.
  const call = <T>(method: Method, arg: unknown, signal: AbortSignal): Promise<T> => rpc.request<T>(
    (id) => ({ type: 'call', id, method, arg } satisfies BridgeRequest),
    {
      signal,
      abortError: () => new Error('cancelled'),
      onAbort: (id) => port.postMessage({ type: 'cancel', id } satisfies BridgeRequest),
    },
  );
  return {
    stats: (signal) => call('stats', null, signal),
    count: (query, signal) => call('count', query, signal),
    distinctValues: (query, signal) => call('distinctValues', query, signal),
    infer: (query, signal) => call('infer', query, signal),
    coverage: (query, signal) => call('coverage', query, signal),
    dispose: () => rpc.dispose(new Error('bridge disposed')),
  };
}

/** Worker side: answer bridge requests from `impl`. Returns a function that stops serving. */
export function serveModelBridge(port: BridgePort, impl: ModelBridge): () => void {
  const running = new Map<number, AbortController>();
  const listener = (event: BridgePortEvent) => {
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
