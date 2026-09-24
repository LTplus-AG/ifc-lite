/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { FoundationApiClient, normalizeApiBaseUrl } from './client.js';
import { FoundationApiError } from './errors.js';
import type { FetchLike } from './types.js';

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetchFn: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, init });
    return handler(url, init);
  };
  return { fetchFn, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Minimal concrete subclass; FoundationApiClient itself carries no resource endpoints of its own. */
class TestClient extends FoundationApiClient {
  probe(path: string): Promise<unknown> {
    return this.requestJsonAt(path);
  }
}

describe('normalizeApiBaseUrl', () => {
  it('strips trailing slashes and pasted version segments', () => {
    expect(normalizeApiBaseUrl('https://host/bcf')).toBe('https://host/bcf');
    expect(normalizeApiBaseUrl('https://host/bcf/')).toBe('https://host/bcf');
    expect(normalizeApiBaseUrl('https://host/bcf/2.1')).toBe('https://host/bcf');
    expect(normalizeApiBaseUrl('https://host/documents/1.0/')).toBe('https://host/documents');
  });

  it('drops a query or fragment, which is never part of a base path', () => {
    expect(normalizeApiBaseUrl('https://host/bcf?tenant=a')).toBe('https://host/bcf');
    expect(normalizeApiBaseUrl('https://host/#/projects')).toBe('https://host');
  });

  it('leaves an address it cannot parse to the request that reports it', () => {
    expect(normalizeApiBaseUrl('not a url/')).toBe('not a url');
  });
});

describe('FoundationApiClient URL construction', () => {
  it('serves /versions beside the version segment, everything else under it', async () => {
    const { fetchFn, requests } = mockFetch((url) =>
      url.endsWith('/versions')
        ? jsonResponse({ versions: [{ api_id: 'foundation', version_id: '1.1' }] })
        : jsonResponse({ id: 'me' }),
    );
    const client = new FoundationApiClient({ baseUrl: 'https://host/foundation/', fetchFn });
    const versions = await client.getVersions();
    expect(versions).toEqual([{ api_id: 'foundation', version_id: '1.1' }]);
    await client.getCurrentUser();
    expect(requests[0].url).toBe('https://host/foundation/versions');
    expect(requests[1].url).toBe('https://host/foundation/1.1/current-user');
  });

  it('defaults the version segment to 1.1', async () => {
    const { fetchFn, requests } = mockFetch(() => jsonResponse({}));
    const client = new FoundationApiClient({ baseUrl: 'https://host/foundation', fetchFn });
    await client.getAuthInfo();
    expect(requests[0].url).toBe('https://host/foundation/1.1/auth');
  });
});

describe('FoundationApiClient auth handling', () => {
  it('attaches the Bearer token from the async provider', async () => {
    const { fetchFn, requests } = mockFetch(() => jsonResponse({ id: 'me' }));
    const client = new FoundationApiClient({
      baseUrl: 'https://host/foundation',
      fetchFn,
      getAccessToken: async () => 'tok-123',
    });
    await client.getCurrentUser();
    expect(new Headers(requests[0].init?.headers).get('Authorization')).toBe('Bearer tok-123');
  });

  it('surfaces a non-2xx response as a FoundationApiError naming the URL and status', async () => {
    const { fetchFn } = mockFetch(() => jsonResponse({ message: 'Not authenticated' }, 401));
    const client = new FoundationApiClient({ baseUrl: 'https://host/foundation', fetchFn });
    const error = await client.getCurrentUser().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FoundationApiError);
    const apiError = error as FoundationApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.isAuthError).toBe(true);
    expect(apiError.message).toBe('Not authenticated');
  });

  it('labels the fallback message OpenCDE by default, when the response carries no detail', async () => {
    const { fetchFn } = mockFetch(() => new Response('<html>gateway timeout</html>', { status: 504 }));
    const client = new FoundationApiClient({ baseUrl: 'https://host/foundation', fetchFn });
    const error = await client.getCurrentUser().catch((e: unknown) => e);
    expect((error as FoundationApiError).message).toBe(
      'OpenCDE request failed (HTTP 504) at https://host/foundation/1.1/current-user',
    );
  });
});

describe('a subclass reuses buildUrl/send/requestJsonAt for its own resources', () => {
  it('resolves a relative path under the client base and version', async () => {
    const { fetchFn, requests } = mockFetch(() => jsonResponse({ ok: true }));
    const client = new TestClient({ baseUrl: 'https://host/documents', version: '1.0', fetchFn });
    const result = await client.probe('/select-documents');
    expect(result).toEqual({ ok: true });
    expect(requests[0].url).toBe('https://host/documents/1.0/select-documents');
  });
});
