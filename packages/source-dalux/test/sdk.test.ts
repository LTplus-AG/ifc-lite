/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import type { PluginContext, KeyValueStore, Logger } from '@ifc-lite/plugin-api';
import { BrowserDaluxApiClient } from '../src/http-client.js';
import { asDaluxHttpClient, createDaluxSdk, DaluxReadOnlyError } from '../src/sdk.js';

const BASE_URL = 'https://node1.field.dalux.com/service/api';

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

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function client(mockFetch: ReturnType<typeof vi.fn>, node?: string): BrowserDaluxApiClient {
  return new BrowserDaluxApiClient(
    { baseUrl: BASE_URL, apiKey: 'k', ...(node ? { node } : {}) },
    createMockCtx(mockFetch as unknown as typeof fetch),
  );
}

describe('createDaluxSdk', () => {
  it('routes a read through this package\'s client and returns a parsed model', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [{ data: { versionSetId: 'vs1', name: 'Initial delivery', fileAreaId: 'fa1' } }],
      }),
    );
    const dalux = createDaluxSdk(client(mockFetch));

    const result = await dalux.versionSets.getVersionSets('P1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe(`${BASE_URL}/2.1/projects/P1/version_sets`);
    expect(result.items?.[0]).toMatchObject({ versionSetId: 'vs1', name: 'Initial delivery' });
  });

  it('keeps the node selector the provider depends on', async () => {
    // The whole reason for adapting this package's client rather than using
    // the library's own fetch transport: Dalux serves no CORS headers, so the
    // request has to keep matching the manifest's declared upstream for the
    // host to route it through the same-origin relay, with the node travelling
    // as a parameter the relay resolves server-side (#2792).
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    const dalux = createDaluxSdk(client(mockFetch, 'node2'));

    await dalux.projects.listProjects();

    expect(String(mockFetch.mock.calls[0]![0])).toContain('daluxNode=node2');
  });

  it('sends the API key without exposing it to the library', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    const daluxClient = client(mockFetch);

    await createDaluxSdk(daluxClient).projects.listProjects();

    const init = mockFetch.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers['X-API-KEY']).toBe('k');
    expect(asDaluxHttpClient(daluxClient).configuration.apiKey).toBeUndefined();
  });

  it('hands a signed download link to the client byte-for-byte', async () => {
    // `new URL(x).toString()` is not identity, and a download link can carry
    // a signature computed over its query string.
    const signed = 'https://storage.example/dl/1?sig=abc&exp=1700000000';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/octet-stream' },
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    });

    const { bytes } = await createDaluxSdk(client(mockFetch, 'node2')).files.downloadFileBytes(signed);

    expect(mockFetch.mock.calls[0]![0]).toBe(signed);
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('forwards an abort signal', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    const controller = new AbortController();

    await asDaluxHttpClient(client(mockFetch)).get('/5.1/projects', {}, { signal: controller.signal });

    expect((mockFetch.mock.calls[0]![1] as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });

  it('refuses writes instead of dropping them', () => {
    const http = asDaluxHttpClient(client(vi.fn()));

    expect(() => http.post('/2.0/things', {})).toThrow(DaluxReadOnlyError);
    expect(() => http.patch('/2.0/things/1', {})).toThrow(DaluxReadOnlyError);
    expect(() => http.delete('/2.0/things/1')).toThrow('read-only');
  });

  it('exposes every endpoint group', () => {
    const dalux = createDaluxSdk(client(vi.fn()));

    expect(Object.keys(dalux).sort()).toEqual(
      [
        'companies', 'companyCatalog', 'fileAreas', 'fileRevisions', 'files', 'folders', 'forms',
        'http', 'inspectionPlans', 'projectTemplates', 'projects', 'tasks', 'testPlans', 'users',
        'versionSets', 'workPackages',
      ].sort(),
    );
  });
});

describe('the eager bundle', () => {
  it('cannot reach the SDK from the package entry point', async () => {
    // `DaluxBuildProvider` is statically imported by the viewer, so anything
    // reachable from `index.ts` is in the eagerly loaded bundle — and the
    // endpoint catalogue costs zod plus its schemas. This is the guard on
    // that: the SDK is a separate subpath (`@ifc-lite/source-dalux/sdk`).
    const entry = await import('../src/index.js');

    expect(Object.keys(entry).sort()).toEqual(
      ['DALUX_MANIFEST', 'DaluxBuildProvider', 'DaluxCommitError', 'invalidateCommitIndex'].sort(),
    );
  });
});
