/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import type { KeyValueStore, Logger, PluginContext } from '@ifc-lite/plugin-api';
import {
  GraphApiError,
  MAX_SWEEP_PAGES,
  graphListAll,
  graphRequest,
  truncateErrorBody,
  type GraphTokenSource,
} from '../src/graph-client.js';

// ---------------------------------------------------------------------------
// Test doubles — same shape as provider.test.ts's, kept local so this file
// can unit-test graph-client.ts directly without going through MsGraphProvider.
// ---------------------------------------------------------------------------

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
    fetchPublic: vi.fn(),
    getPreference: vi.fn(() => Promise.resolve(undefined)),
    storage: createMockStorage(),
    log: createMockLogger(),
  };
}

function jsonResponse(body: unknown, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    ...overrides,
  };
}

const auth: GraphTokenSource = { getAccessToken: vi.fn().mockResolvedValue('tok') };

describe('resolveUrl host allowlist', () => {
  it('refuses to attach a bearer token to an absolute URL whose host is not graph.microsoft.com', async () => {
    const mockFetch = vi.fn();
    const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

    // Simulates a tampered/foreign cursor smuggled in as a "nextLink".
    await expect(graphRequest(ctx, auth, 'https://evil.example.com/steal-token')).rejects.toThrow(
      /evil\.example\.com/,
    );
    // The request must never have been issued — the check happens before `ctx.fetch`.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('still allows a request to graph.microsoft.com itself (e.g. a real nextLink)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ value: [] }));
    const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

    await graphRequest(ctx, auth, 'https://graph.microsoft.com/v1.0/me/drives?$skiptoken=abc');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/me/drives?$skiptoken=abc',
      expect.any(Object),
    );
  });

  it('resolves a bare path against GRAPH_BASE without touching the allowlist', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ value: [] }));
    const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

    await graphRequest(ctx, auth, '/me');
    expect(mockFetch).toHaveBeenCalledWith('https://graph.microsoft.com/v1.0/me', expect.any(Object));
  });
});

describe('truncateErrorBody', () => {
  it('leaves short text untouched', () => {
    expect(truncateErrorBody('short body')).toBe('short body');
  });

  it('caps long text to ~200 chars with a trailing ellipsis', () => {
    const long = 'x'.repeat(500);
    const truncated = truncateErrorBody(long);
    expect(truncated.length).toBe(201); // 200 chars + the ellipsis character
    expect(truncated.endsWith('…')).toBe(true);
    expect(truncated.startsWith('x'.repeat(200))).toBe(true);
  });
});

describe('GraphApiError body handling', () => {
  it('truncates the body embedded in the thrown message but logs the full body to ctx.log.error', async () => {
    const longBody = 'y'.repeat(2000);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: { get: () => null },
      text: () => Promise.resolve(longBody),
    });
    const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

    let caught: unknown;
    try {
      await graphRequest(ctx, auth, '/me');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GraphApiError);
    expect((caught as Error).message.length).toBeLessThan(400);
    expect((caught as Error).message).not.toContain(longBody);
    expect(ctx.log.error).toHaveBeenCalledWith(expect.any(String), { body: longBody });
  });
});

describe('graphListAll pagination guards', () => {
  it('throws instead of looping forever when the same nextLink is re-issued', async () => {
    const repeatedLink = 'https://graph.microsoft.com/v1.0/me/drives?$skiptoken=stuck';
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({ value: [{ id: 'd1' }], '@odata.nextLink': repeatedLink }),
    );
    const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

    await expect(graphListAll(ctx, auth, '/me/drives')).rejects.toThrow(/same nextLink/);
    // First page (no cursor yet) + one repeat before the guard fires.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws after exceeding MAX_SWEEP_PAGES rather than hanging on an endlessly-fresh bookmark', async () => {
    let page = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      page += 1;
      return Promise.resolve(
        jsonResponse({
          value: [],
          '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/drives?$skiptoken=${page}`,
        }),
      );
    });
    const ctx = createMockCtx(mockFetch as unknown as typeof fetch);

    await expect(graphListAll(ctx, auth, '/me/drives')).rejects.toThrow(new RegExp(`${MAX_SWEEP_PAGES} pages`));
  });
});
