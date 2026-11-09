/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import { afterEach, expect, it, vi } from 'vitest';
import { IfcServerClient } from './client.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const client = () => new IfcServerClient({ baseUrl: 'https://example.invalid' });
for (const method of ['fetchDataModel', 'fetchSymbolic'] as const) {
  it(`${method} propagates HTTP failures (lifecycle audit)`, async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    await expect(client()[method]('key', 1)).rejects.toThrow();
  });
  it(`${method} propagates exhausted transport failures (lifecycle audit)`, async () => {
    const failure = new Error('offline');
    vi.stubGlobal('fetch', vi.fn(async () => { throw failure; }));
    await expect(client()[method]('key', 1)).rejects.toBe(failure);
  });
  it.each([404, 202])(`${method} reserves null for absence or pending data: %s (lifecycle audit)`, async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
    expect(await client()[method]('key', 1)).toBeNull();
  });
  it(`${method} stops an in-flight request on caller abort (lifecycle audit)`, async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const pending = client()[method]('key', { signal: controller.signal });
    controller.abort(new Error('caller-left'));
    await expect(pending).rejects.toThrow('caller-left');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it(`${method} cancels backoff without another fetch (lifecycle audit)`, async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetcher);
    const pending = client()[method]('key', { signal: controller.signal });
    await Promise.resolve(); await Promise.resolve();
    controller.abort(new Error('caller-left'));
    await expect(pending).rejects.toThrow('caller-left');
    await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it(`${method} does not dispatch when already aborted (lifecycle audit)`, async () => {
    const controller = new AbortController(); controller.abort(new Error('already-left'));
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(client()[method]('key', { signal: controller.signal })).rejects.toThrow('already-left');
    expect(fetcher).not.toHaveBeenCalled();
  });
}
