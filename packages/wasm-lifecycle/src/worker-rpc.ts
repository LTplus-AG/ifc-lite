/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Request/response bookkeeping over one worker (or any message endpoint),
 * with a dead latch.
 *
 * Every hand-rolled copy of this got the same things wrong at least once: a
 * worker that crashed or sent an unreadable message left its pending map
 * hanging forever, a request whose `postMessage` threw left a deadline timer
 * that later killed the client under unrelated requests, and a call after
 * `dispose()` waited for an answer that could never come. The contract here:
 *
 * - **Dead latch.** The first fatal reason wins (`fail`, `dispose`, a worker
 *   `error`/`messageerror`, a killing deadline, a failed start). It
 *   terminates the worker, rejects every pending request and a pending
 *   `start`, tells `onDeath` listeners, and makes every later `request`
 *   reject at once with the same reason.
 * - **Post-throw cleanup.** A `postMessage` that throws (e.g. a
 *   `DataCloneError`) never reached the worker, which is fine: only that
 *   request rejects, and its entry, deadline and abort listener go with it.
 * - **Deadlines** use `armDeadline`'s clamping: `0`, negative, `NaN` and
 *   `Infinity` mean "no deadline", and anything past 2^31-1 ms is clamped
 *   rather than firing after 1 ms. A request deadline either kills the whole
 *   endpoint (a wasm call cannot be interrupted) or rejects just that request.
 * - **Start** runs a one-off handshake (post init, wait for ready) under its
 *   own deadline; any failure during it is fatal.
 */

import { armDeadline } from './deadline.js';

/** A decoded answer to one request: a value, or the error it failed with. */
export type RpcReply<Id> = { id: Id; value: unknown } | { id: Id; error: Error };

/** What a start handshake makes of one inbound message (`undefined`: not for it). */
export type RpcStartStep<T> = { ready: T } | { error: Error } | undefined;

/** The part of `Worker` a worker-backed RPC uses. */
export type RpcWorker = Pick<Worker, 'postMessage' | 'terminate' | 'addEventListener' | 'removeEventListener'>;

interface RpcOptionsBase<Id> {
  /** Names the endpoint in error messages, e.g. `'Re-mesh worker'`. */
  label: string;
  /** Map one inbound message to the request it answers, or `undefined` to ignore it. */
  decode: (data: unknown) => RpcReply<Id> | undefined;
  /** Id generator; required unless ids are numbers (then 1, 2, 3, …). */
  nextId?: () => Id;
  /** Default per-request deadline (see `armDeadline`). Default: none. */
  requestTimeoutMs?: number;
  /**
   * `'kill'` (default): a missed deadline is fatal for the endpoint, for work
   * that cannot be interrupted. `'reject'`: only the late request rejects.
   */
  onRequestTimeout?: 'kill' | 'reject';
}

/** Worker-backed: posts to it, listens to its `message`/`error`/`messageerror`, terminates it on death. */
export interface WorkerRpcOptions<Id> extends RpcOptionsBase<Id> {
  worker: RpcWorker;
}

/**
 * Transport-backed: the caller owns the listening and feeds inbound messages
 * through `receive()` (and fatal transport failures through `fail()`).
 */
export interface PortRpcOptions<Id> extends RpcOptionsBase<Id> {
  post: (message: unknown, transfer: Transferable[]) => void;
  /** Release the transport on death, if it has anything to release. */
  close?: () => void;
}

export interface RpcRequestOptions<Id> {
  transfer?: Transferable[];
  /** Overrides the endpoint's `requestTimeoutMs` for this request. */
  timeoutMs?: number;
  /** Error for a missed deadline; default `"<label> did not answer within <ms> ms"`. */
  timeoutError?: () => Error;
  /** Called with the id before the message is posted (e.g. to cancel it later). */
  onId?: (id: Id) => void;
  /**
   * Abandon the request when this fires: it rejects with `abortError()`, its
   * entry is dropped (a late answer is ignored) and `onAbort(id)` runs, e.g.
   * to tell the other side to stop.
   */
  signal?: AbortSignal;
  onAbort?: (id: Id) => void;
  abortError?: () => Error;
}

export interface RpcStartOptions<T> {
  /** Send the init message. A throw is fatal. */
  post: () => void;
  /** Recognise the handshake answer; messages it returns `undefined` for flow on to `decode`. */
  accept: (data: unknown) => RpcStartStep<T>;
  /** Start deadline (see `armDeadline`). Expiry is fatal. */
  timeoutMs: number;
  timeoutError?: () => Error;
}

export interface WorkerRpc<Id> {
  readonly label: string;
  /** False once dead (disposed, crashed, timed out); create a new one then. */
  readonly alive: boolean;
  /** Why it died, or `null` while alive. */
  readonly deadReason: Error | null;
  /** Run the init handshake. Resolves with the ready payload; any failure kills the endpoint. */
  start<T>(options: RpcStartOptions<T>): Promise<T>;
  /** Send a message that expects exactly one answer, correlated by id. */
  request<T>(build: (id: Id) => unknown, options?: RpcRequestOptions<Id>): Promise<T>;
  /** Fire-and-forget message. No-op once dead; a throwing post propagates. */
  notify(message: unknown, transfer?: Transferable[]): void;
  /** Feed one inbound message. True when it settled a request or the start handshake. */
  receive(data: unknown): boolean;
  /** The dead latch: first reason wins. */
  fail(reason: Error): void;
  /** `fail` with a disposal reason. Idempotent. */
  dispose(reason?: Error): void;
  /** Run `listener` once on death (at once if already dead). Returns the unsubscribe. */
  onDeath(listener: (reason: Error) => void): () => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Run every step even when one throws; rethrow the first error afterwards. */
function runAll(steps: Array<() => void>): void {
  let failure: { error: unknown } | null = null;
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

function sequentialIds(): () => number {
  let next = 1;
  return () => next++;
}

/** Create the RPC; see the module comment for the contract. Ids are 1, 2, 3, … */
export function createWorkerRpc(options: WorkerRpcOptions<number> | PortRpcOptions<number>): WorkerRpc<number>;
/** Create the RPC with caller-chosen ids (e.g. UUIDs). */
export function createWorkerRpc<Id>(options: (WorkerRpcOptions<Id> | PortRpcOptions<Id>) & { nextId: () => Id }): WorkerRpc<Id>;
export function createWorkerRpc<Id>(options: WorkerRpcOptions<Id> | PortRpcOptions<Id>): WorkerRpc<Id | number> {
  const { label, decode } = options;
  const nextId: () => Id | number = options.nextId ?? sequentialIds();
  const defaultTimeoutMs = options.requestTimeoutMs ?? 0;
  const timeoutKills = (options.onRequestTimeout ?? 'kill') === 'kill';
  const pending = new Map<Id | number, Pending>();
  const deathListeners = new Set<(reason: Error) => void>();
  let dead: Error | null = null;
  let starter: ((data: unknown) => boolean) | null = null;
  let detach: (() => void) | null = null;

  const worker = 'worker' in options ? options.worker : null;
  const post = worker
    ? (message: unknown, transfer: Transferable[]) => worker.postMessage(message, transfer)
    : (options as PortRpcOptions<Id>).post;
  const close = worker ? () => worker.terminate() : (options as PortRpcOptions<Id>).close;

  const fail = (reason: Error): void => {
    if (dead) return;
    dead = reason;
    starter = null;
    // Settle every caller first: nothing below (a throwing terminate, close or
    // listener) may leave a promise pending. Then release the transport and
    // tell every listener even if one step throws; the first error still
    // reaches the caller of `fail` / `dispose`.
    const settled = [...pending.values()];
    pending.clear();
    for (const entry of settled) entry.reject(reason);
    const listeners = [...deathListeners];
    deathListeners.clear();
    runAll([() => detach?.(), () => close?.(), ...listeners.map((listener) => () => listener(reason))]);
  };

  const receive = (data: unknown): boolean => {
    let reply: RpcReply<Id | number> | undefined;
    try {
      if (starter?.(data)) return true;
      reply = decode(data);
    } catch (error) {
      // A message the protocol cannot read (a throwing `decode` or start
      // `accept`) is fatal, as `messageerror` is: escaping the listener
      // instead would leave its request, or the start, waiting forever.
      fail(toError(error));
      return false;
    }
    if (!reply) return false;
    const entry = pending.get(reply.id);
    // A late answer to an abandoned, timed-out or never-posted request.
    if (!entry) return false;
    pending.delete(reply.id);
    if ('error' in reply) entry.reject(reply.error);
    else entry.resolve(reply.value);
    return true;
  };

  if (worker) {
    const onMessage = (event: MessageEvent) => { receive(event.data); };
    const onError = (event: ErrorEvent) => fail(new Error(`${label} failed: ${event.message || 'unknown error'}`));
    const onMessageError = () => fail(new Error(`${label} sent a message that could not be read`));
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    detach = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
    };
  }

  const onDeath = (listener: (reason: Error) => void): (() => void) => {
    if (dead) {
      listener(dead);
      return () => {};
    }
    deathListeners.add(listener);
    return () => { deathListeners.delete(listener); };
  };

  const start = <T>(startOptions: RpcStartOptions<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    if (dead) { reject(dead); return; }
    if (starter) { reject(new Error(`${label} is already starting`)); return; }
    let cancelDeadline = (): void => {};
    const stopListening = onDeath((reason) => { cancelDeadline(); reject(reason); });
    cancelDeadline = armDeadline(startOptions.timeoutMs, () => fail(
      startOptions.timeoutError?.() ?? new Error(`${label} did not start within ${startOptions.timeoutMs} ms`),
    ));
    starter = (data) => {
      const step = startOptions.accept(data);
      if (!step) return false;
      starter = null;
      cancelDeadline();
      stopListening();
      if ('error' in step) {
        reject(step.error);
        fail(step.error);
      } else {
        resolve(step.ready);
      }
      return true;
    };
    try {
      startOptions.post();
    } catch (error) {
      fail(toError(error));
    }
  });

  const request = <T>(build: (id: Id | number) => unknown, requestOptions: RpcRequestOptions<Id | number> = {}): Promise<T> => {
    if (dead) return Promise.reject(dead);
    const { signal } = requestOptions;
    const abortError = requestOptions.abortError ?? (() => new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = nextId();
    requestOptions.onId?.(id);
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = requestOptions.timeoutMs ?? defaultTimeoutMs;
      const timeoutError = () => requestOptions.timeoutError?.() ?? new Error(`${label} did not answer within ${timeoutMs} ms`);
      // Both run only while the request is pending: settling removes them.
      const onAbort = () => {
        pending.delete(id);
        cleanup();
        // Settle before telling the other side, whose post may throw.
        reject(abortError());
        requestOptions.onAbort?.(id);
      };
      const cancelDeadline = armDeadline(timeoutMs, () => {
        if (timeoutKills) {
          fail(timeoutError());
        } else {
          pending.delete(id);
          cleanup();
          reject(timeoutError());
        }
      });
      const cleanup = () => {
        cancelDeadline();
        signal?.removeEventListener('abort', onAbort);
      };
      pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value as T); },
        reject: (error) => { cleanup(); reject(error); },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        post(build(id), requestOptions.transfer ?? []);
      } catch (error) {
        // Never reached the other side: fail only this request.
        pending.delete(id);
        cleanup();
        reject(toError(error));
      }
    });
  };

  return {
    label,
    get alive() { return dead === null; },
    get deadReason() { return dead; },
    start,
    request,
    notify(message, transfer = []) {
      if (dead) return;
      post(message, transfer);
    },
    receive,
    fail,
    dispose(reason) {
      fail(reason ?? new Error(`${label} is disposed`));
    },
    onDeath,
  };
}
