/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FetchLike } from '@ifc-lite/opencde-foundation';
import { describe, expect, it } from 'vitest';
import { discoverDocumentsService } from './discovery.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('discoverDocumentsService', () => {
  it('resolves to the api_base_url a /foundation/versions listing reports', async () => {
    const urls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      urls.push(url);
      return jsonResponse({
        versions: [
          { api_id: 'foundation', version_id: '1.1' },
          { api_id: 'bcf', version_id: '3.0', api_base_url: 'https://cde.example/bcf/3.0' },
          { api_id: 'documents', version_id: '1.0', api_base_url: 'https://cde.example/docs/1.0' },
        ],
      });
    };
    const discovered = await discoverDocumentsService({ baseUrl: 'https://cde.example', fetchFn });
    expect(discovered.baseUrl).toBe('https://cde.example/docs/1.0');
    expect(discovered.version.version_id).toBe('1.0');
    expect(urls).toEqual(['https://cde.example/foundation/versions']);
  });

  it('derives the base URL from server_base_url/documents/version_id when none is relocated', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse({ versions: [{ api_id: 'documents', version_id: '1.0' }] });
    const discovered = await discoverDocumentsService({ baseUrl: 'https://cde.example/', fetchFn });
    expect(discovered.baseUrl).toBe('https://cde.example/documents/1.0');
  });

  it('rejects a server that does not list the documents API at all', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse({ versions: [{ api_id: 'bcf', version_id: '2.1' }] });
    await expect(discoverDocumentsService({ baseUrl: 'https://cde.example', fetchFn })).rejects.toThrow(
      'does not advertise the OpenCDE Documents API',
    );
  });
});
