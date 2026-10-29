/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SPIKE: BIMcollab Documents API client — URL shape, space-id extraction,
 * paging, and the two-hop download that must not forward the bearer token.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BimcollabDocumentsClient,
  BimcollabDocumentsError,
  isBimcollabServerUrl,
  isOpenableModelDocument,
  spaceIdFromAccessToken,
} from './bimcollab-documents.js';

const SPACE = '8e3136c4-2e93-4819-a44e-227c59de8f02';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

interface Call { url: string; init?: RequestInit }

function fakeFetch(routes: (url: string) => Response): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return routes(url);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('spaceIdFromAccessToken', () => {
  it('reads the spaceGuid claim BIMcollab issues', () => {
    assert.equal(spaceIdFromAccessToken(jwt({ aud: 'bcf', spaceGuid: SPACE.toUpperCase() })), SPACE);
  });
  it('prefers spaceGuid over other space-named GUID claims', () => {
    const other = '00000000-0000-0000-0000-000000000001';
    assert.equal(spaceIdFromAccessToken(jwt({ parentSpace: other, spaceGuid: SPACE })), SPACE);
  });
  it('falls back to another space-named GUID claim', () => {
    assert.equal(spaceIdFromAccessToken(jwt({ sub: 'u', space_id: SPACE })), SPACE);
  });
  it('returns empty for tokens without one, and for non-JWTs', () => {
    assert.equal(spaceIdFromAccessToken(jwt({ sub: 'u', space: 'myspace' })), '');
    assert.equal(spaceIdFromAccessToken('opaque-token'), '');
  });
});

describe('helpers', () => {
  it('recognises BIMcollab space URLs', () => {
    assert.equal(isBimcollabServerUrl('https://myspace.bimcollab.com/bcf'), true);
    assert.equal(isBimcollabServerUrl('https://bimcollab.com.evil.example/bcf'), false);
  });
  it('only offers IFC model files for opening', () => {
    assert.equal(isOpenableModelDocument({ documentId: 'a', latestVersion: { documentVersionId: 'v', documentId: 'a', fileName: 'Arch.IFC' } }), true);
    assert.equal(isOpenableModelDocument({ documentId: 'a', latestVersion: { documentVersionId: 'v', documentId: 'a', fileName: 'plan.pdf' } }), false);
  });
});

describe('BimcollabDocumentsClient', () => {
  it('scopes requests by space in the path and authenticates them', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ locations: [] }));
    const client = new BimcollabDocumentsClient({ spaceId: SPACE, getAccessToken: () => 'tok', fetchFn });
    await client.getProjectStructure();
    assert.equal(calls[0].url, `https://api.eu.bimcollab.com/spaces/${SPACE}/documents/v1/project-structure`);
    const headers = new Headers(calls[0].init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer tok');
    assert.equal(headers.get('bimcollab-space-guid'), SPACE);
  });

  it('pages documents until a short page', async () => {
    const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ documentId: `d${from + i}` }));
    const { fetchFn, calls } = fakeFetch((url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      return json(offset === 0 ? page(100, 0) : page(3, 100));
    });
    const client = new BimcollabDocumentsClient({ spaceId: SPACE, getAccessToken: () => 'tok', fetchFn });
    const documents = await client.listDocuments({ projectId: 'p1' }, { searchText: 'arch' });
    assert.equal(documents.length, 103);
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /\/projects\/p1\/documents\?searchText=arch&limit=100&offset=100$/);
  });

  it('downloads through the pre-signed URL without the bearer token', async () => {
    const blobUrl = 'https://blob.example/doc?sig=1';
    const { fetchFn, calls } = fakeFetch((url) => url === blobUrl
      ? new Response('ISO-10303-21;')
      : json({ downloadUrl: blobUrl, fileName: 'Arch.ifc' }));
    const client = new BimcollabDocumentsClient({ spaceId: SPACE, getAccessToken: () => 'tok', fetchFn });
    const file = await client.downloadFile({ documentVersionId: 'v1' });
    assert.match(calls[0].url, /\/document-versions\/v1\/download$/);
    assert.equal(calls[1].url, blobUrl);
    assert.equal(new Headers(calls[1].init?.headers).get('authorization'), null);
    assert.equal(calls[1].init?.credentials, 'omit');
    assert.equal(file.name, 'Arch.ifc');
    assert.equal(await file.text(), 'ISO-10303-21;');
  });

  it('surfaces ProblemDetails titles with the status', async () => {
    const { fetchFn } = fakeFetch(() => json({ title: 'Forbidden' }, 403));
    const client = new BimcollabDocumentsClient({ spaceId: SPACE, getAccessToken: () => 'tok', fetchFn });
    await assert.rejects(client.listVersions('d1'), (error: unknown) =>
      error instanceof BimcollabDocumentsError && error.status === 403 && /Forbidden/.test(error.message));
  });

  it('rejects a non-GUID space id', () => {
    assert.throws(() => new BimcollabDocumentsClient({ spaceId: 'myspace', getAccessToken: () => 'tok' }));
  });
});
