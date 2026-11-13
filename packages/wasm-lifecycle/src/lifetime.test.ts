/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `createLifetime`: single-flight, generation-checked init (audit P6 semantics, #9500). */

import { describe, expect, it } from 'vitest';
import { createLifetime, type LifetimeAttempt } from './lifetime.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A lifetime whose attempts are scripted by the test, one deferred each. */
function scripted<T>() {
  const attempts: Array<ReturnType<typeof deferred<T>> & { attempt: LifetimeAttempt; args: unknown[] }> = [];
  const released: T[] = [];
  const lifetime = createLifetime<T, [label?: string]>({
    start: (attempt, ...args) => {
      const d = deferred<T>();
      attempts.push({ ...d, attempt, args });
      return d.promise;
    },
    release: (value) => released.push(value),
  });
  return { lifetime, attempts, released };
}

describe('createLifetime', () => {
  it('concurrent init() calls join one attempt; ready resolves from cache', async () => {
    const { lifetime, attempts } = scripted<string>();
    const a = lifetime.init('first');
    const b = lifetime.init('second');
    expect(attempts).toHaveLength(1);
    expect(attempts[0].args).toEqual(['first']);
    expect(lifetime.state.kind).toBe('initializing');
    attempts[0].resolve('engine');
    await expect(Promise.all([a, b])).resolves.toEqual(['engine', 'engine']);
    await expect(lifetime.init()).resolves.toBe('engine');
    expect(attempts).toHaveLength(1);
    expect(lifetime.state.kind).toBe('ready');
    expect(lifetime.value).toBe('engine');
  });

  it('a failed attempt is forgotten, so the next init() retries', async () => {
    const { lifetime, attempts } = scripted<string>();
    const first = lifetime.init();
    attempts[0].reject(new Error('transient'));
    await expect(first).rejects.toThrow('transient');
    expect(lifetime.state).toMatchObject({ kind: 'failed' });
    const second = lifetime.init();
    expect(attempts).toHaveLength(2);
    attempts[1].resolve('engine');
    await expect(second).resolves.toBe('engine');
  });

  it('a synchronous throw from start is a failed attempt, not a crash', async () => {
    const lifetime = createLifetime<number>({ start: () => { throw new Error('sync'); } });
    await expect(lifetime.init()).rejects.toThrow('sync');
    expect(lifetime.state.kind).toBe('failed');
  });

  it('dispose() makes an in-flight attempt stale: its success rejects as superseded and is released, not cached', async () => {
    const { lifetime, attempts, released } = scripted<string>();
    const stale = lifetime.init();
    lifetime.dispose();
    expect(attempts[0].attempt.isCurrent()).toBe(false);
    attempts[0].resolve('leaked?');
    await expect(stale).rejects.toThrow(/superseded by dispose/);
    expect(released).toEqual(['leaked?']);
    expect(lifetime.state.kind).toBe('disposed');
  });

  it('init after dispose rebuilds, and the stale attempt settling late does not drop the fresh one', async () => {
    const { lifetime, attempts } = scripted<string>();
    const stale = lifetime.init();
    lifetime.dispose();
    const fresh = lifetime.init();
    expect(attempts).toHaveLength(2);
    expect(attempts[1].attempt.isCurrent()).toBe(true);
    attempts[0].resolve('old');
    await expect(stale).rejects.toThrow(/superseded/);
    const joined = lifetime.init();
    expect(attempts).toHaveLength(2);
    attempts[1].resolve('new');
    await expect(Promise.all([fresh, joined])).resolves.toEqual(['new', 'new']);
  });

  it('a stale FAILURE does not mark the newer attempt failed or drop it', async () => {
    const { lifetime, attempts } = scripted<string>();
    const stale = lifetime.init();
    lifetime.dispose();
    const fresh = lifetime.init();
    attempts[0].reject(new Error('old failure'));
    await expect(stale).rejects.toThrow('old failure');
    expect(lifetime.state.kind).toBe('initializing');
    const joined = lifetime.init();
    expect(attempts).toHaveLength(2);
    attempts[1].resolve('new');
    await expect(Promise.all([fresh, joined])).resolves.toEqual(['new', 'new']);
  });

  it('dispose() releases a ready value; reset() releases it without superseding an attempt', async () => {
    const { lifetime, attempts, released } = scripted<string>();
    const first = lifetime.init();
    attempts[0].resolve('a');
    await first;
    lifetime.reset();
    expect(released).toEqual(['a']);
    expect(lifetime.state.kind).toBe('idle');
    const second = lifetime.init();
    lifetime.reset();
    attempts[1].resolve('b');
    await expect(second).resolves.toBe('b');
    lifetime.dispose();
    lifetime.dispose();
    expect(released).toEqual(['a', 'b']);
  });

  it('reset() after a failure returns to idle', async () => {
    const { lifetime, attempts } = scripted<string>();
    const first = lifetime.init();
    attempts[0].reject(new Error('x'));
    await expect(first).rejects.toThrow('x');
    lifetime.reset();
    expect(lifetime.state.kind).toBe('idle');
  });
});
