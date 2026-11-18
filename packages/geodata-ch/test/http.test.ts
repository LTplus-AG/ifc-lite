/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpClient, HttpError, HttpTimeoutError, type CachedResponse } from '../src/http.js';

function scripted(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error('script exhausted');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

describe('HttpClient', () => {
  it('retries 503 and network errors with exponential backoff, then succeeds', async () => {
    const s = scripted([new Response('busy', { status: 503 }), new TypeError('socket hang up'), new Response('ok')]);
    const c = clock();
    const http = new HttpClient({ fetch: s.fetch, ...c, random: () => 0.5, requestsPerSecond: 1000 });
    const res = await http.get('https://api.test/x');
    expect(new TextDecoder().decode(res.body)).toBe('ok');
    expect(s.calls).toHaveLength(3);
    // Backoffs: 1000·2^0 + 0.5·1000, then 1000·2^1 + 0.5·1000 (rate-limit waits are ~1 ms here).
    const backoffs = c.sleeps.filter((ms) => ms > 10);
    expect(backoffs).toEqual([1500, 2500]);
  });

  it('honours Retry-After on 429', async () => {
    const s = scripted([new Response('', { status: 429, headers: { 'retry-after': '7' } }), new Response('ok')]);
    const c = clock();
    const http = new HttpClient({ fetch: s.fetch, ...c, requestsPerSecond: 1000 });
    await http.get('https://api.test/x');
    expect(c.sleeps.filter((ms) => ms > 10)).toEqual([7000]);
  });

  it('does not retry a 404 and reports status and body', async () => {
    const s = scripted([new Response('{"detail":"No GeoTable"}', { status: 404 })]);
    const http = new HttpClient({ fetch: s.fetch, ...clock() });
    const err = await http.get('https://api.test/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).body).toContain('No GeoTable');
    expect(s.calls).toHaveLength(1);
  });

  it('gives up after maxRetries', async () => {
    const s = scripted([new Response('', { status: 502 }), new Response('', { status: 502 }), new Response('', { status: 502 })]);
    const http = new HttpClient({ fetch: s.fetch, ...clock(), maxRetries: 2 });
    await expect(http.get('https://api.test/x')).rejects.toMatchObject({ status: 502 });
    expect(s.calls).toHaveLength(3);
  });

  it('spaces requests to one host at the configured rate, independently per host', async () => {
    const s = scripted([new Response('a'), new Response('b'), new Response('c'), new Response('d')]);
    const c = clock();
    const http = new HttpClient({ fetch: s.fetch, now: c.now, sleep: c.sleep, requestsPerSecond: 5 });
    await Promise.all([
      http.get('https://a.test/1'),
      http.get('https://a.test/2'),
      http.get('https://a.test/3'),
      http.get('https://b.test/1'),
    ]);
    // Host a: slots at 0, 200, 400 ms (sleeps relative to a clock the sleeps themselves advance).
    expect(c.sleeps).toEqual([200, 200]);
  });

  it('serves repeats from the cache hook, keyed by URL and Range', async () => {
    const store = new Map<string, CachedResponse>();
    const s = scripted([
      new Response('whole'),
      new Response('part', { status: 206, headers: { 'content-range': 'bytes 0-3/10' } }),
    ]);
    const http = new HttpClient({ fetch: s.fetch, ...clock(), cache: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) } });
    await http.get('https://api.test/f');
    await http.get('https://api.test/f');
    const part = await http.get('https://api.test/f', { headers: { Range: 'bytes=0-3' } });
    await http.get('https://api.test/f', { headers: { Range: 'bytes=0-3' } });
    expect(s.calls).toHaveLength(2);
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 0-3/10');
    expect(http.requestCount).toBe(2);
  });

  it('sends a generic User-Agent outside browsers and nothing identifying', async () => {
    const s = scripted([new Response('ok')]);
    await new HttpClient({ fetch: s.fetch, ...clock() }).get('https://api.test/x');
    const headers = s.calls[0].init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('ifc-lite-geodata-ch');
    expect(Object.keys(headers)).toEqual(['User-Agent']);
  });

  it('stops on abort', async () => {
    const ac = new AbortController();
    ac.abort();
    const http = new HttpClient({ fetch: scripted([]).fetch, ...clock() });
    await expect(http.get('https://api.test/x', { signal: ac.signal })).rejects.toThrow();
  });
});

/** A fetch that never answers on its own and rejects when its signal aborts, like a stalled socket. */
function stalled(signalLog: Array<AbortSignal | undefined> = []) {
  return (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      signalLog.push(init?.signal ?? undefined);
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
}

describe('HttpClient timeout', () => {
  it('aborts a stalled request, retries it, and succeeds on the next attempt', async () => {
    let n = 0;
    const fetch = (url: string, init?: RequestInit): Promise<Response> =>
      n++ === 0 ? stalled()(url, init) : Promise.resolve(new Response('ok'));
    const http = new HttpClient({ fetch, ...clock(), timeoutMs: 20, random: () => 0 });
    const res = await http.get('https://api.test/x');
    expect(new TextDecoder().decode(res.body)).toBe('ok');
    expect(http.requestCount).toBe(2);
  });

  it('throws a typed HttpTimeoutError once the retry budget is spent', async () => {
    const http = new HttpClient({ fetch: stalled(), ...clock(), timeoutMs: 15, maxRetries: 1 });
    const err = await http.get('https://api.test/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpTimeoutError);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpTimeoutError).timeoutMs).toBe(15);
    expect((err as HttpTimeoutError).status).toBeNull();
    expect(http.requestCount).toBe(2);
  });

  it('also covers a body that stalls after the headers arrived', async () => {
    const fetch = (_u: string, init?: RequestInit): Promise<Response> =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: () =>
          new Promise<ArrayBuffer>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal?.reason), { once: true })),
      } as unknown as Response);
    const http = new HttpClient({ fetch, ...clock(), timeoutMs: 15, maxRetries: 0 });
    await expect(http.get('https://api.test/x')).rejects.toBeInstanceOf(HttpTimeoutError);
  });

  it("lets the caller's signal abort a stalled request without retrying, with the caller's reason", async () => {
    const ac = new AbortController();
    const log: Array<AbortSignal | undefined> = [];
    const http = new HttpClient({ fetch: stalled(log), ...clock(), timeoutMs: 60_000 });
    const pending = http.get('https://api.test/x', { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort(new Error('user cancelled'));
    await expect(pending).rejects.toThrow('user cancelled');
    expect(log).toHaveLength(1);
  });

  it('timeoutMs: 0 disables the per-attempt timeout (the caller signal is passed through)', async () => {
    const ac = new AbortController();
    const log: Array<AbortSignal | undefined> = [];
    const http = new HttpClient({ fetch: stalled(log), ...clock(), timeoutMs: 0 });
    const pending = http.get('https://api.test/x', { signal: ac.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    expect(log[0]).toBe(ac.signal);
    ac.abort();
    expect(await pending).toBeDefined();
  });
});

describe('HttpClient retry details', () => {
  it('passes the request signal to an injected sleep', async () => {
    const ac = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const s = scripted([new Response('', { status: 503 }), new Response('ok')]);
    const http = new HttpClient({
      fetch: s.fetch,
      now: () => 0,
      sleep: async (_ms, signal) => void seen.push(signal),
      random: () => 0,
      requestsPerSecond: 1000,
    });
    await http.get('https://api.test/x', { signal: ac.signal });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((sig) => sig === ac.signal)).toBe(true);
  });

  it('honours a Retry-After HTTP-date, capped like the seconds form', async () => {
    const base = Date.parse('2026-11-15T12:00:00Z');
    const retry = async (header: string) => {
      const s = scripted([new Response('', { status: 429, headers: { 'retry-after': header } }), new Response('ok')]);
      const sleeps: number[] = [];
      const http = new HttpClient({
        fetch: s.fetch,
        now: () => base,
        sleep: async (ms) => void sleeps.push(ms),
        requestsPerSecond: 1000,
        maxDelayMs: 32_000,
      });
      await http.get('https://api.test/x');
      return sleeps.filter((ms) => ms > 10);
    };
    expect(await retry('Sun, 15 Nov 2026 12:00:09 GMT')).toEqual([9000]);
    expect(await retry('Sun, 15 Nov 2026 13:00:00 GMT')).toEqual([32_000]);
    // A date already past means retry now, not the exponential backoff.
    expect(await retry('Sun, 15 Nov 2026 11:00:00 GMT')).toEqual([]);
  });
});

describe('User-Agent by capability', () => {
  afterEach(() => vi.unstubAllGlobals());

  const headersOf = async (): Promise<Record<string, string>> => {
    const s = scripted([new Response('ok')]);
    await new HttpClient({ fetch: s.fetch, ...clock() }).get('https://api.test/x');
    return s.calls[0].init?.headers as Record<string, string>;
  };

  it('sends none from a web worker, which has no document but preflights the header', async () => {
    vi.stubGlobal('WorkerGlobalScope', class {});
    expect(await headersOf()).toEqual({});
  });

  it('sends none from a window even when a bundler polyfills process', async () => {
    vi.stubGlobal('window', {});
    expect(await headersOf()).toEqual({});
  });

  it('can be switched off in Node with userAgent: null', async () => {
    const s = scripted([new Response('ok')]);
    await new HttpClient({ fetch: s.fetch, ...clock(), userAgent: null }).get('https://api.test/x');
    expect(s.calls[0].init?.headers).toEqual({});
  });
});

