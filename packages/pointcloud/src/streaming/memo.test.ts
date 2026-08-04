/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { memoizeAsync } from './memo.js';

/** A factory whose settlement each caller controls, plus a call counter. */
function deferredFactory<T>() {
  const gates: Array<{ resolve: (v: T) => void; reject: (e: unknown) => void }> = [];
  let calls = 0;
  const factory = (): Promise<T> => {
    calls++;
    return new Promise<T>((resolve, reject) => {
      gates.push({ resolve, reject });
    });
  };
  return { factory, gates, get calls() { return calls; } };
}

describe('memoizeAsync', () => {
  it('caches a fulfilled value and never calls the factory again', async () => {
    let calls = 0;
    const load = memoizeAsync(async () => {
      calls++;
      return 'module';
    });

    expect(await load()).toBe('module');
    expect(await load()).toBe('module');
    expect(calls).toBe(1);
  });

  it('shares one in-flight promise between concurrent callers', async () => {
    const d = deferredFactory<string>();
    const load = memoizeAsync(d.factory);

    const a = load();
    const b = load();
    // The factory call is deferred by a microtask; let it happen.
    await Promise.resolve();
    expect(d.calls).toBe(1);

    d.gates[0].resolve('module');
    expect(await a).toBe('module');
    expect(await b).toBe('module');
  });

  it('retries after a rejection instead of caching the failure', async () => {
    let calls = 0;
    const load = memoizeAsync(async () => {
      calls++;
      if (calls === 1) throw new Error('transient fetch failure');
      return 'module';
    });

    await expect(load()).rejects.toThrow('transient fetch failure');
    expect(await load()).toBe('module');
    expect(calls).toBe(2);
  });

  it('rejects concurrent callers together, then lets a later caller retry', async () => {
    const d = deferredFactory<string>();
    const load = memoizeAsync(d.factory);

    const a = load();
    const b = load();
    await Promise.resolve();
    expect(d.calls).toBe(1);

    d.gates[0].reject(new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');

    const c = load();
    await Promise.resolve();
    expect(d.calls).toBe(2);
    d.gates[1].resolve('module');
    expect(await c).toBe('module');
  });

  it('surfaces a synchronous throw as a rejection and still allows a retry', async () => {
    let calls = 0;
    const load = memoizeAsync((): Promise<string> => {
      calls++;
      if (calls === 1) throw new Error('sync boom');
      return Promise.resolve('module');
    });

    await expect(load()).rejects.toThrow('sync boom');
    expect(await load()).toBe('module');
  });
});
