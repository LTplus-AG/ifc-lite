/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { apiBaseUrlFor, findApiVersion, getFoundationVersions, resolveApiBaseUrl } from './discovery.js';
import { FoundationApiError } from './errors.js';
import type { FetchLike, FoundationVersion } from './types.js';

describe('resolveApiBaseUrl', () => {
  it('stops at the first candidate the probe accepts, probing no further', async () => {
    const tried: string[] = [];
    const resolved = await resolveApiBaseUrl(['https://a.example.com', 'https://b.example.com'], async (baseUrl) => {
      tried.push(baseUrl);
      return baseUrl;
    });
    expect(resolved).toBe('https://a.example.com');
    expect(tried).toEqual(['https://a.example.com']);
  });

  it('falls through to the next candidate only after the previous one fails', async () => {
    const tried: string[] = [];
    const resolved = await resolveApiBaseUrl(['https://a.example.com', 'https://b.example.com'], async (baseUrl) => {
      tried.push(baseUrl);
      if (baseUrl !== 'https://b.example.com') throw new FoundationApiError('nope', { status: 404, url: baseUrl });
      return baseUrl;
    });
    expect(resolved).toBe('https://b.example.com');
    expect(tried).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('prefers a rejected-credentials error over a wrong-address 404', async () => {
    const error = await resolveApiBaseUrl(['https://a.example.com', 'https://b.example.com'], async (baseUrl) => {
      throw baseUrl.endsWith('b.example.com')
        ? new FoundationApiError('Not authenticated', { status: 401, url: baseUrl })
        : new FoundationApiError('Not found', { status: 404, url: baseUrl });
    }).catch((e: unknown) => e);
    expect((error as FoundationApiError).status).toBe(401);
    expect((error as FoundationApiError).message).toBe('Not authenticated');
  });

  it('rethrows the first error when no candidate produced a FoundationApiError', async () => {
    const error = await resolveApiBaseUrl(['https://a.example.com'], async (baseUrl) => {
      throw new TypeError(`Failed to fetch ${baseUrl}`);
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toBe('Failed to fetch https://a.example.com');
  });
});

describe('getFoundationVersions', () => {
  it('fetches /foundation/versions at the server base, regardless of any API relocation', async () => {
    const urls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          versions: [
            { api_id: 'foundation', version_id: '1.1' },
            { api_id: 'documents', version_id: '1.0', api_base_url: 'https://server.example/docs/1.0' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const versions = await getFoundationVersions({ baseUrl: 'https://server.example/', fetchFn });
    expect(urls).toEqual(['https://server.example/foundation/versions']);
    expect(versions).toHaveLength(2);
  });
});

describe('findApiVersion', () => {
  const versions: FoundationVersion[] = [
    { api_id: 'bcf', version_id: '2.1' },
    { api_id: 'bcf', version_id: '3.0' },
    { api_id: 'documents', version_id: '1.0' },
  ];

  it('picks the highest version_id when a server lists more than one', () => {
    expect(findApiVersion(versions, 'bcf')?.version_id).toBe('3.0');
  });

  it('returns undefined for an API the server does not offer', () => {
    expect(findApiVersion(versions, 'unknown')).toBeUndefined();
  });
});

describe('apiBaseUrlFor', () => {
  it('uses the relocated api_base_url when the server provides one', () => {
    const url = apiBaseUrlFor('https://server.example', {
      api_id: 'documents',
      version_id: '1.0',
      api_base_url: 'https://other-host.example/docs/1.0/',
    });
    expect(url).toBe('https://other-host.example/docs/1.0');
  });

  it('derives {serverBaseUrl}/{api_id}/{version_id} when no api_base_url is given', () => {
    const url = apiBaseUrlFor('https://server.example/', { api_id: 'documents', version_id: '1.0' });
    expect(url).toBe('https://server.example/documents/1.0');
  });
});
