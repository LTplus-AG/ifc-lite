/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Single-flight, generation-checked init for a long-lived resource (an engine
 * handle, a native bridge, a wasm module).
 *
 * A `boolean` plus a cached promise cannot tell "in flight" from "not
 * started", nor notice a `dispose()` that landed mid-init: overlapping
 * `init()` calls each built a resource (the first leaked), init resumed after
 * `dispose()` to resurrect it, and a stale attempt's failure cleared the
 * promise of the attempt that replaced it. The contract here:
 *
 * - Concurrent `init()` calls join one in-flight attempt; once `ready`, init
 *   resolves with the cached value.
 * - A failed attempt is forgotten (`failed`), so the next `init()` retries.
 * - `dispose()` bumps the generation and releases a ready value. An attempt
 *   started under an older generation is stale: its success rejects as
 *   superseded (its value is released, never cached) and its failure touches
 *   nothing. `start` can poll `attempt.isCurrent()` to skip building at all.
 * - Dispose is not terminal: the next `init()` builds afresh.
 */

export type LifetimeState<T> =
  | { kind: 'idle'; generation: number }
  | { kind: 'initializing'; generation: number; promise: Promise<T> }
  | { kind: 'ready'; generation: number; value: T }
  | { kind: 'failed'; generation: number; error: unknown }
  | { kind: 'disposed'; generation: number };

/** The attempt `start` is running for. */
export interface LifetimeAttempt {
  readonly generation: number;
  /** False once a `dispose()` overtook this attempt. */
  isCurrent(): boolean;
}

export interface LifetimeOptions<T, A extends unknown[]> {
  /** Build the resource. `args` are the ones the `init()` that started this attempt got. */
  start: (attempt: LifetimeAttempt, ...args: A) => Promise<T>;
  /** Free a value that is disposed, reset, or built by a superseded attempt. */
  release?: (value: T) => void;
  /** Rejection for an attempt a `dispose()` overtook. */
  supersededError?: () => Error;
}

export interface Lifetime<T, A extends unknown[] = []> {
  readonly state: LifetimeState<T>;
  /** The value while `ready`, else `undefined`. */
  readonly value: T | undefined;
  /** Start, join, or return the ready value. `args` only matter when a fresh attempt starts. */
  init(...args: A): Promise<T>;
  /** Drop (and release) a ready value or a failure, back to `idle`; an in-flight attempt is untouched. */
  reset(): void;
  /** Overtake any in-flight attempt and release a ready value. The next `init()` rebuilds. */
  dispose(): void;
}

/** Create the lifetime; see the module comment for the contract. */
export function createLifetime<T, A extends unknown[] = []>(options: LifetimeOptions<T, A>): Lifetime<T, A> {
  let state: LifetimeState<T> = { kind: 'idle', generation: 0 };
  const superseded = options.supersededError ?? (() => new Error('init was superseded by dispose() before it finished'));

  const init = (...args: A): Promise<T> => {
    if (state.kind === 'ready') return Promise.resolve(state.value);
    if (state.kind === 'initializing') return state.promise;
    const { generation } = state;
    const attempt: LifetimeAttempt = { generation, isCurrent: () => state.generation === generation };
    let settle!: { resolve: (value: T) => void; reject: (error: unknown) => void };
    const promise = new Promise<T>((resolve, reject) => { settle = { resolve, reject }; });
    // Recorded before `start` runs, so even a synchronous throw finds its own attempt.
    state = { kind: 'initializing', generation, promise };
    const run = async (): Promise<T> => {
      let value: T;
      try {
        value = await options.start(attempt, ...args);
      } catch (error) {
        // A stale failure must not touch the attempt that replaced it.
        if (state.kind === 'initializing' && state.promise === promise) state = { kind: 'failed', generation, error };
        throw error;
      }
      if (!attempt.isCurrent()) {
        options.release?.(value);
        throw superseded();
      }
      state = { kind: 'ready', generation, value };
      return value;
    };
    run().then(settle.resolve, settle.reject);
    return promise;
  };

  return {
    get state() { return state; },
    get value() { return state.kind === 'ready' ? state.value : undefined; },
    init,
    reset() {
      if (state.kind === 'ready') {
        const { value } = state;
        state = { kind: 'idle', generation: state.generation };
        options.release?.(value);
      } else if (state.kind === 'failed') {
        state = { kind: 'idle', generation: state.generation };
      }
    },
    dispose() {
      const previous = state;
      state = { kind: 'disposed', generation: previous.generation + 1 };
      if (previous.kind === 'ready') options.release?.(previous.value);
    },
  };
}
