/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { BcfApiClient, normalizeBcfBaseUrl } from './client.js';
import { BcfApiError } from './errors.js';
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

describe('normalizeBcfBaseUrl', () => {
  it('strips trailing slashes and pasted version segments', () => {
    expect(normalizeBcfBaseUrl('https://host/bcf')).toBe('https://host/bcf');
    expect(normalizeBcfBaseUrl('https://host/bcf/')).toBe('https://host/bcf');
    expect(normalizeBcfBaseUrl('https://host/bcf/2.1')).toBe('https://host/bcf');
    expect(normalizeBcfBaseUrl('https://host/bcf/3.0/')).toBe('https://host/bcf');
    expect(normalizeBcfBaseUrl('  https://host/bcf  ')).toBe('https://host/bcf');
  });

  it('keeps URLs whose last segment is not a version number', () => {
    expect(normalizeBcfBaseUrl('https://host/api/v1')).toBe('https://host/api/v1');
  });
});

describe('BcfApiClient URL construction', () => {
  it('serves /versions beside the version segment, everything else under it', async () => {
    const { fetchFn, requests } = mockFetch((url) =>
      url.endsWith('/versions')
        ? jsonResponse({ versions: [{ version_id: '2.1' }] })
        : jsonResponse([]),
    );
    const client = new BcfApiClient({ baseUrl: 'https://host/bcf/', fetchFn });
    const versions = await client.getVersions();
    expect(versions).toEqual([{ version_id: '2.1' }]);
    await client.getProjects();
    expect(requests[0].url).toBe('https://host/bcf/versions');
    expect(requests[1].url).toBe('https://host/bcf/2.1/projects');
  });

  it('encodes OData topic query options as $-prefixed params', async () => {
    const { fetchFn, requests } = mockFetch(() => jsonResponse([]));
    const client = new BcfApiClient({ baseUrl: 'https://host/bcf', fetchFn });
    await client.getTopics('p1', { top: 50, skip: 100, filter: "topic_status eq 'Open'" });
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe('/bcf/2.1/projects/p1/topics');
    expect(url.searchParams.get('$top')).toBe('50');
    expect(url.searchParams.get('$skip')).toBe('100');
    expect(url.searchParams.get('$filter')).toBe("topic_status eq 'Open'");
    expect(url.searchParams.has('$orderby')).toBe(false);
  });

  it('URL-encodes project and topic identifiers', async () => {
    const { fetchFn, requests } = mockFetch(() => jsonResponse([]));
    const client = new BcfApiClient({ baseUrl: 'https://host/bcf', fetchFn });
    await client.getComments('a b', 'c/d');
    expect(requests[0].url).toBe('https://host/bcf/2.1/projects/a%20b/topics/c%2Fd/comments');
  });
});

describe('BcfApiClient auth handling', () => {
  it('attaches the Bearer token from the async provider', async () => {
    const { fetchFn, requests } = mockFetch(() => jsonResponse([]));
    const client = new BcfApiClient({
      baseUrl: 'https://host/bcf',
      fetchFn,
      getAccessToken: async () => 'tok-123',
    });
    await client.getProjects();
    expect(new Headers(requests[0].init?.headers).get('Authorization')).toBe('Bearer tok-123');
  });

  it('sends no Authorization header when the provider yields undefined', async () => {
    const { fetchFn, requests } = mockFetch(() => jsonResponse([]));
    const client = new BcfApiClient({
      baseUrl: 'https://host/bcf',
      fetchFn,
      getAccessToken: () => undefined,
    });
    await client.getVersions();
    expect(new Headers(requests[0].init?.headers).get('Authorization')).toBeNull();
  });

  it('surfaces 401 as an isAuthError BcfApiError with the server message', async () => {
    const { fetchFn } = mockFetch(() => jsonResponse({ message: 'Not authenticated' }, 401));
    const client = new BcfApiClient({ baseUrl: 'https://host/bcf', fetchFn });
    const error = await client.getProjects().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BcfApiError);
    const apiError = error as BcfApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.isAuthError).toBe(true);
    expect(apiError.message).toBe('Not authenticated');
  });

  it('reports non-JSON error bodies by status line', async () => {
    const { fetchFn } = mockFetch(
      () => new Response('<html>gateway timeout</html>', { status: 504 }),
    );
    const client = new BcfApiClient({ baseUrl: 'https://host/bcf', fetchFn });
    const error = await client.getProjects().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BcfApiError);
    expect((error as BcfApiError).message).toBe('BCF request failed (HTTP 504)');
  });
});

describe('BcfApiClient bodies and binary responses', () => {
  it('POSTs comments as JSON with Content-Type', async () => {
    const { fetchFn, requests } = mockFetch(() =>
      jsonResponse({ guid: 'c1', comment: 'hello' }),
    );
    const client = new BcfApiClient({ baseUrl: 'https://host/bcf', fetchFn });
    const created = await client.createComment('p1', 't1', { comment: 'hello' });
    expect(created.guid).toBe('c1');
    expect(requests[0].init?.method).toBe('POST');
    expect(new Headers(requests[0].init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ comment: 'hello' });
  });

  it('returns the snapshot as a Blob with its content type', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { fetchFn, requests } = mockFetch(
      () => new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    const client = new BcfApiClient({ baseUrl: 'https://host/bcf', fetchFn });
    const blob = await client.getViewpointSnapshot('p1', 't1', 'v1');
    expect(requests[0].url).toBe(
      'https://host/bcf/2.1/projects/p1/topics/t1/viewpoints/v1/snapshot',
    );
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(4);
  });
});
