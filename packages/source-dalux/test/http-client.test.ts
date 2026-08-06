/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import type { PluginContext, KeyValueStore, Logger } from '@ifc-lite/plugin-api';
import { BrowserDaluxApiClient, DaluxPaginationError, fetchAllPages, fetchPage } from '../src/http-client.js';

function createMockStorage(): KeyValueStore {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key))),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve([...store.keys()])),
  };
}

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createMockCtx(fetchImpl: typeof fetch): PluginContext {
  return {
    fetch: fetchImpl,
    fetchPublic: vi.fn(() => Promise.reject(new Error('fetchPublic not used in these tests'))),
    getPreference: vi.fn(() => Promise.resolve('test-key')),
    storage: createMockStorage(),
    log: createMockLogger(),
  };
}

function mockResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: () => Promise.resolve(undefined),
    text: () => Promise.resolve(''),
    ...overrides,
  };
}

function client(mockFetch: ReturnType<typeof vi.fn>): BrowserDaluxApiClient {
  const ctx = createMockCtx(mockFetch as unknown as typeof fetch);
  return new BrowserDaluxApiClient({ baseUrl: 'https://node1.field.dalux.com/service/api', apiKey: 'k' }, ctx);
}

describe('fetchPage', () => {
  it('returns items and no cursor for a single, complete page', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve({ items: [{ a: 1 }, { a: 2 }] }) }),
    );
    const result = await fetchPage(client(mockFetch), '/x', {}, undefined);
    expect(result.items).toEqual([{ a: 1 }, { a: 2 }]);
    expect(result.cursor).toBeUndefined();
  });

  it('treats a bare-array response as a complete page', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse({ json: () => Promise.resolve([{ a: 1 }]) }));
    const result = await fetchPage(client(mockFetch), '/x', {}, undefined);
    expect(result.items).toEqual([{ a: 1 }]);
    expect(result.cursor).toBeUndefined();
  });

  it('extracts the bookmark from an absolute nextPage href as the cursor', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            items: [{ a: 1 }],
            metadata: { totalRemainingItems: 1 },
            links: [{ rel: 'nextPage', href: 'https://node1.field.dalux.com/service/api/x?bookmark=abc123' }],
          }),
      }),
    );
    const result = await fetchPage(client(mockFetch), '/x', {}, undefined);
    expect(result.cursor).toBe('abc123');
  });

  it('resolves a relative nextPage href against the client base URL instead of throwing', async () => {
    // A bare `new URL(href)` on a relative href throws a TypeError. This is
    // the exact shape the vendored library's own reference pager guards
    // against with try/catch.
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            items: [{ a: 1 }],
            metadata: { totalRemainingItems: 1 },
            links: [{ rel: 'nextPage', href: '/service/api/x?bookmark=rel-bookmark' }],
          }),
      }),
    );
    const result = await fetchPage(client(mockFetch), '/x', {}, undefined);
    expect(result.cursor).toBe('rel-bookmark');
  });

  it('maps a supplied cursor onto the bookmark query param of the request', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse({ json: () => Promise.resolve({ items: [] }) }));
    await fetchPage(client(mockFetch), '/x', { folderId: 'f1' }, 'my-cursor');
    const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('bookmark')).toBe('my-cursor');
    expect(calledUrl.searchParams.get('folderId')).toBe('f1');
  });

  it('throws when a nextPage link has no bookmark, instead of silently ending the listing', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            items: [{ a: 1 }],
            metadata: { totalRemainingItems: 1 },
            links: [{ rel: 'nextPage', href: 'https://node1.field.dalux.com/service/api/x' }],
          }),
      }),
    );
    await expect(fetchPage(client(mockFetch), '/x', {}, undefined)).rejects.toThrow(DaluxPaginationError);
  });

  it('throws when the nextPage bookmark echoes the one just requested', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            items: [{ a: 1 }],
            metadata: { totalRemainingItems: 1 },
            links: [{ rel: 'nextPage', href: 'https://node1.field.dalux.com/service/api/x?bookmark=same' }],
          }),
      }),
    );
    await expect(fetchPage(client(mockFetch), '/x', {}, 'same')).rejects.toThrow(DaluxPaginationError);
  });

  it('treats a page with no nextPage link as the last page, even when metadata reports remaining items', async () => {
    // Dalux's own reference client (dalux-build's `paginate` helper) never
    // treats `totalRemainingItems` as authoritative — it only logs it and
    // stops as soon as `links` has no `nextPage` entry. Real responses (e.g.
    // `/5.1/projects` with exactly one project) can report a positive
    // `totalRemainingItems` on the page that is genuinely the last one.
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({
        json: () => Promise.resolve({ items: [{ a: 1 }], metadata: { totalRemainingItems: 1 }, links: [] }),
      }),
    );
    const result = await fetchPage(client(mockFetch), '/x', {}, undefined);
    expect(result.items).toEqual([{ a: 1 }]);
    expect(result.cursor).toBeUndefined();
  });

  it('follows a nextPage link on an empty page instead of throwing (bookmark pager can signal "keep going" on an empty page)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            items: [],
            links: [{ rel: 'nextPage', href: 'https://node1.field.dalux.com/service/api/x?bookmark=b2' }],
          }),
      }),
    );
    const result = await fetchPage(client(mockFetch), '/x', {}, undefined);
    expect(result.items).toEqual([]);
    expect(result.cursor).toBe('b2');
  });

  it('follows a nextPage link when totalRemainingItems is 0 instead of throwing', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            items: [],
            metadata: { totalRemainingItems: 0 },
            links: [{ rel: 'nextPage', href: 'https://node1.field.dalux.com/service/api/x?bookmark=zz' }],
          }),
      }),
    );
    const result = await fetchPage(client(mockFetch), '/x', {}, undefined);
    expect(result.items).toEqual([]);
    expect(result.cursor).toBe('zz');
  });

  it('follows a nextPage link on a non-empty page even when totalRemainingItems is 0', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            items: [{ a: 1 }],
            metadata: { totalRemainingItems: 0 },
            links: [{ rel: 'nextPage', href: 'https://node1.field.dalux.com/service/api/x?bookmark=zz' }],
          }),
      }),
    );
    const result = await fetchPage(client(mockFetch), '/x', {}, undefined);
    expect(result.items).toEqual([{ a: 1 }]);
    expect(result.cursor).toBe('zz');
  });

  it('truncates an upstream error body to ~200 chars instead of putting the whole thing in the thrown message', async () => {
    const longBody = 'x'.repeat(5000);
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 500, statusText: 'Internal Server Error', text: () => Promise.resolve(longBody) }),
    );
    await expect(fetchPage(client(mockFetch), '/x', {}, undefined)).rejects.toThrow(
      /Dalux API 500: Internal Server Error/,
    );
    try {
      await fetchPage(client(mockFetch), '/x', {}, undefined);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message.length).toBeLessThan(250);
    }
  });

  it('threads an AbortSignal through to the underlying fetch', async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn().mockResolvedValue(mockResponse({ json: () => Promise.resolve({ items: [] }) }));
    await fetchPage(client(mockFetch), '/x', {}, undefined, controller.signal);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe('fetchAllPages', () => {
  it('follows every page and concatenates all items', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const bookmark = new URL(url).searchParams.get('bookmark');
      if (!bookmark) {
        return Promise.resolve(
          mockResponse({
            json: () =>
              Promise.resolve({
                items: [{ id: 1 }],
                metadata: { totalRemainingItems: 1 },
                links: [{ rel: 'nextPage', href: `${url}?bookmark=page2` }],
              }),
          }),
        );
      }
      if (bookmark === 'page2') {
        return Promise.resolve(
          mockResponse({ json: () => Promise.resolve({ items: [{ id: 2 }], metadata: { totalRemainingItems: 0 } }) }),
        );
      }
      return Promise.resolve(mockResponse({ json: () => Promise.resolve({ items: [] }) }));
    });

    const items = await fetchAllPages(client(mockFetch), '/x');
    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws when a bookmark reappears later in the sweep, not just on the immediately preceding page', async () => {
    // page1 -> bookmark "a", page2 (bookmark=a) -> bookmark "b", page3
    // (bookmark=b) -> bookmark "a" again. fetchPage's own immediate-echo
    // check can't see this (the echoed value is two hops back, not one),
    // so this specifically exercises fetchAllPages' own seenBookmarks set.
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const bookmark = new URL(url).searchParams.get('bookmark');
      const next = bookmark === null ? 'a' : bookmark === 'a' ? 'b' : 'a';
      return Promise.resolve(
        mockResponse({
          json: () =>
            Promise.resolve({
              items: [{ bookmark }],
              metadata: { totalRemainingItems: 1 },
              links: [{ rel: 'nextPage', href: `${url.split('?')[0]}?bookmark=${next}` }],
            }),
        }),
      );
    });

    await expect(fetchAllPages(client(mockFetch), '/x')).rejects.toThrow(DaluxPaginationError);
  });

  it('enforces a hard page cap instead of looping forever on endlessly fresh bookmarks', async () => {
    let counter = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      counter += 1;
      const next = `bm-${counter}`;
      return Promise.resolve(
        mockResponse({
          json: () =>
            Promise.resolve({
              items: [{ n: counter }],
              metadata: { totalRemainingItems: 1 },
              links: [{ rel: 'nextPage', href: `${url.split('?')[0]}?bookmark=${next}` }],
            }),
        }),
      );
    });

    await expect(fetchAllPages(client(mockFetch), '/x')).rejects.toThrow(DaluxPaginationError);
    expect(mockFetch).toHaveBeenCalledTimes(1000);
  });

  it('stops cleanly (no throw) when a page has no items', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse({ json: () => Promise.resolve({ items: [] }) }));
    const items = await fetchAllPages(client(mockFetch), '/x');
    expect(items).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
