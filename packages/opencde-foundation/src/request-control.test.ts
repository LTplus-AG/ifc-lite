/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { FoundationApiClient, type FoundationRequestOptions } from './client.js';
import type { FetchLike } from './types.js';

/** Exposes the protected request path exactly as a concrete service client uses it. */
class ProbeClient extends FoundationApiClient {
  call(path: string, options: FoundationRequestOptions): Promise<unknown> {
    return this.requestJsonAt(path, options);
  }
}

/** A fetch that never answers on its own: it settles only when its signal aborts (#6896). */
function hangingFetch(seen: RequestInit[]): FetchLike {
  return (_url, init) => {
    if (init) seen.push(init);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  };
}

describe('request cancellation, timeout and headers (#6896)', () => {
  it('forwards custom headers next to the bearer token without letting them replace it', async () => {
    const seen: RequestInit[] = [];
    const client = new ProbeClient({
      baseUrl: 'https://host/bcf', getAccessToken: () => 'token-1',
      fetchFn: async (_url, init) => { if (init) seen.push(init); return new Response('{}', { status: 200 }); },
    });
    await client.call('/projects', { headers: { 'X-Request-Id': 'abc' } });
    const headers = new Headers(seen[0].headers);
    expect(headers.get('X-Request-Id')).toBe('abc');
    expect(headers.get('Authorization')).toBe('Bearer token-1');
  });

  it('a timeout aborts an unanswered request instead of waiting forever', async () => {
    const seen: RequestInit[] = [];
    const client = new ProbeClient({ baseUrl: 'https://host/bcf', fetchFn: hangingFetch(seen) });
    const error = await client.call('/projects', { method: 'POST', body: { title: 'x' }, timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('TimeoutError');
    expect(seen).toHaveLength(1);
    expect(seen[0].signal?.aborted).toBe(true);
  });

  it('a caller abort during the request rejects it; the request was already dispatched', async () => {
    const seen: RequestInit[] = [];
    const client = new ProbeClient({ baseUrl: 'https://host/bcf', fetchFn: hangingFetch(seen) });
    const controller = new AbortController();
    const pending = client.call('/projects', { method: 'POST', body: {}, signal: controller.signal, timeoutMs: 60_000 });
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
    expect(seen).toHaveLength(1);
  });

  it('an already-aborted signal refuses before fetch is called, so nothing is sent', async () => {
    const seen: RequestInit[] = [];
    const client = new ProbeClient({ baseUrl: 'https://host/bcf', fetchFn: hangingFetch(seen) });
    const controller = new AbortController();
    controller.abort(new Error('cancelled first'));
    await expect(client.call('/projects', { method: 'POST', body: {}, signal: controller.signal })).rejects.toThrow('cancelled first');
    expect(seen).toHaveLength(0);
  });

  it('requests without a signal or timeout keep the previous fetch init shape', async () => {
    const seen: RequestInit[] = [];
    const client = new ProbeClient({
      baseUrl: 'https://host/bcf',
      fetchFn: async (_url, init) => { if (init) seen.push(init); return new Response('[]', { status: 200 }); },
    });
    await client.call('/projects', {});
    expect('signal' in seen[0]).toBe(false);
  });
});
