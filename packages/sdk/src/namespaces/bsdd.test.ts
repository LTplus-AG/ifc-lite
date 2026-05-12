/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lock-in tests for the bSDD client's HTTP error handling. The bug being
 * pinned: previously every fetch failure returned `null` from
 * `fetchClassInfo`, masking 429 rate-limits as "class not found". Now 404
 * still returns null but other failures throw a typed `BsddHttpError` with
 * the upstream status and any `Retry-After` hint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BsddNamespace, BsddHttpError } from './bsdd.js';

type FetchSpy = ReturnType<typeof vi.fn>;
let originalFetch: typeof globalThis.fetch;

function mockFetchOnceWith(status: number, body: unknown, headers: Record<string, string> = {}): FetchSpy {
  const spy = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : status === 429 ? 'Too Many Requests' : `HTTP ${status}`,
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
    json: async () => body,
  })) as unknown as FetchSpy;
  globalThis.fetch = spy as unknown as typeof globalThis.fetch;
  return spy;
}

beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('BsddNamespace HTTP error handling', () => {
  it('returns null on 404 from fetchClassInfo (genuine not-found)', async () => {
    mockFetchOnceWith(404, {});
    const ns = new BsddNamespace();
    const info = await ns.fetchClassInfo('IfcMadeUpEntity');
    expect(info).toBeNull();
  });

  it('throws BsddHttpError on 429 from fetchClassInfo (rate-limited)', async () => {
    mockFetchOnceWith(429, { message: 'Too many requests' }, { 'retry-after': '7' });
    const ns = new BsddNamespace();
    await expect(ns.fetchClassInfo('IfcWall')).rejects.toMatchObject({
      name: 'BsddHttpError',
      status: 429,
      retryAfterSeconds: 7,
    });
  });

  it('throws BsddHttpError on 500 from fetchClassInfo (upstream error)', async () => {
    mockFetchOnceWith(500, { message: 'kaboom' });
    const ns = new BsddNamespace();
    const promise = ns.fetchClassInfo('IfcWall');
    await expect(promise).rejects.toBeInstanceOf(BsddHttpError);
    await expect(promise).rejects.toMatchObject({ status: 500 });
  });

  it('throws BsddHttpError on 429 from search (was previously swallowed → [])', async () => {
    mockFetchOnceWith(429, {});
    const ns = new BsddNamespace();
    await expect(ns.search('wall')).rejects.toMatchObject({ name: 'BsddHttpError', status: 429 });
  });

  it('parses HTTP-date Retry-After into seconds', async () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    mockFetchOnceWith(429, {}, { 'retry-after': future });
    const ns = new BsddNamespace();
    try {
      await ns.fetchClassInfo('IfcWall');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BsddHttpError);
      const seconds = (err as BsddHttpError).retryAfterSeconds ?? 0;
      // Allow timing slop — should land in [25, 35] seconds
      expect(seconds).toBeGreaterThanOrEqual(25);
      expect(seconds).toBeLessThanOrEqual(35);
    }
  });
});
