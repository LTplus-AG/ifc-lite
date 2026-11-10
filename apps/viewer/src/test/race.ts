/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Race test kit (implicit-state audit, section 2.5): the pieces every
 * "who owns this run" test needs, so each one decides by hand when every
 * async step lands instead of hoping the scheduler orders them.
 *
 * - {@link deferred}: a promise the test settles.
 * - {@link interleave}: run steps in a fixed order with the microtask queue
 *   drained between them, so each step sees everything the previous one
 *   scheduled (a `then` chain, a zustand subscriber, an `await` in a task).
 * - {@link installFakeWorker}: a `Worker` stand-in that records what was posted,
 *   answers when told, and can die the three ways a real one does (an `error`
 *   event, a `messageerror`, or silently).
 *
 * Waiting on a condition or on event-loop turns is `./settle.ts`; this module
 * never sleeps.
 */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  /** True once `resolve` or `reject` ran. */
  settled(): boolean;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let done = false;
  const promise = new Promise<T>((ok, fail) => {
    resolve = (value) => { done = true; ok(value); };
    reject = (error) => { done = true; fail(error); };
  });
  return { promise, resolve, reject, settled: () => done };
}

/** Microtask hops drained after each step; deeper chains call `interleave` again. */
const DRAIN_HOPS = 10;

async function drain(): Promise<void> {
  for (let hop = 0; hop < DRAIN_HOPS; hop++) await Promise.resolve();
}

/**
 * Run `steps` in order, draining the microtask queue after each. A step may
 * be async; it is awaited first. React callers wrap the call in `act`.
 */
export async function interleave(...steps: Array<() => unknown>): Promise<void> {
  for (const step of steps) {
    await step();
    await drain();
  }
}

/** The `AbortError` a cancelled fetch or `signal.throwIfAborted()` throws. */
export function abortError(message = 'The operation was aborted.'): DOMException {
  return new DOMException(message, 'AbortError');
}

type Listener = (event: Event) => void;

/** One constructed fake worker. */
export interface FakeWorker {
  readonly url: string;
  /** Every message posted to the worker, in order. */
  readonly posted: unknown[];
  /** True once `terminate()` ran. */
  terminated(): boolean;
  /** Deliver `data` to the page as the worker's reply. Ignored once the worker is dead. */
  reply(data: unknown): void;
  /** The worker crashes: an `error` event, as an uncaught exception in it raises. */
  crash(message?: string): void;
  /** A reply the page cannot deserialize: a `messageerror` event. */
  messageError(): void;
  /** The OS kills the worker: no event at all, later posts vanish. */
  die(): void;
}

export interface FakeWorkerInstall {
  /** Workers constructed since install, oldest first. */
  readonly workers: FakeWorker[];
  /** The most recently constructed worker. */
  latest(): FakeWorker;
  restore(): void;
}

/**
 * Replace `globalThis.Worker` with a fake until `restore()`. Supports both
 * `onmessage`/`onerror`/`onmessageerror` properties and `addEventListener`.
 */
export function installFakeWorker(): FakeWorkerInstall {
  const g = globalThis as { Worker?: unknown };
  const had = Object.hasOwn(g, 'Worker');
  const original = g.Worker;
  const workers: FakeWorker[] = [];

  class Fake {
    onmessage: Listener | null = null;
    onerror: Listener | null = null;
    onmessageerror: Listener | null = null;
    private readonly listeners = new Map<string, Set<Listener>>();
    private dead = false;
    private stopped = false;
    readonly handle: FakeWorker;

    constructor(url: string | URL) {
      const posted: unknown[] = [];
      this.handle = {
        url: String(url),
        posted,
        terminated: () => this.stopped,
        reply: (data) => this.emit('message', Object.assign(new Event('message'), { data })),
        crash: (message = 'worker crashed') => {
          this.emit('error', Object.assign(new Event('error'), { message }));
          this.dead = true;
        },
        messageError: () => this.emit('messageerror', new Event('messageerror')),
        die: () => { this.dead = true; },
      };
      workers.push(this.handle);
    }

    postMessage(message: unknown): void {
      if (this.stopped) throw new Error('postMessage on a terminated worker');
      if (!this.dead) this.handle.posted.push(message);
    }

    terminate(): void {
      this.stopped = true;
      this.dead = true;
    }

    addEventListener(type: string, listener: Listener): void {
      let set = this.listeners.get(type);
      if (!set) this.listeners.set(type, set = new Set());
      set.add(listener);
    }

    removeEventListener(type: string, listener: Listener): void {
      this.listeners.get(type)?.delete(listener);
    }

    private emit(type: 'message' | 'error' | 'messageerror', event: Event): void {
      if (this.dead) return;
      const property = type === 'message' ? this.onmessage : type === 'error' ? this.onerror : this.onmessageerror;
      property?.(event);
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
  }

  g.Worker = Fake;
  return {
    workers,
    latest: () => {
      const worker = workers.at(-1);
      if (!worker) throw new Error('no fake worker was constructed');
      return worker;
    },
    restore: () => {
      if (had) g.Worker = original;
      else delete g.Worker;
    },
  };
}
