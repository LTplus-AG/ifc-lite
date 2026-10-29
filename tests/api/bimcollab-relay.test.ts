/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBimcollabRelayHandler, loadBimcollabRelayConfig, resolveBimcollabRoute } from '../../server/sources/bimcollab-relay.js';
import { bimcollabTokenEndpoint } from '../../server/bcf/bimcollab-token-grant.js';

const GUID = '12345678-1234-1234-abcd-123456789abc';
const ORIGIN = 'https://www.ifclite.com';
const DOCS = `docs/${GUID}`;
function request(path = `${DOCS}/projects`, init: RequestInit = {}) {
  return new Request(`${ORIGIN}/api/bimcollab/${path}`, {
    ...init, headers: { authorization: 'Bearer fake-token', ...Object.fromEntries(new Headers(init.headers)) },
  });
}
function fixture(respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const calls: { url: string; init: RequestInit; headers: Headers }[] = [];
  const handler = createBimcollabRelayHandler(loadBimcollabRelayConfig({}), { fetchImpl: async (url, init = {}) => {
    calls.push({ url: String(url), init, headers: new Headers(init.headers) });
    return respond(String(url), init);
  } });
  return { handler, calls };
}

test('BIMcollab relay: anchored read paths and GUIDs only, no traversal or escaped separators', () => {
  const allowed = ['project-structure', 'projects', 'project-phases', 'projects/id_1/documents',
    'project-phases/id-2/documents', 'projects/id/document-sets', 'project-phases/id/document-sets',
    `documents/${GUID}`, 'documents/id/document-versions', 'documents/id/download',
    'document-versions/id', 'document-versions/id/download'];
  for (const tail of allowed) assert.ok(resolveBimcollabRoute(`${DOCS}/${tail}`), tail);
  for (const tail of ['', 'documents', 'companies', 'projects/id/upload', 'projects//documents',
    'projects/../documents', 'projects/%2e%2e/documents', 'projects/a%2fb/documents',
    'projects/a%252fb/documents', 'projects/a\\b/documents', 'projects/a.b/documents', 'projects/a/documents/extra']) {
    assert.equal(resolveBimcollabRoute(`${DOCS}/${tail}`), null, tail);
  }
  for (const guid of ['1', GUID + 'x', GUID.replace(/-/g, ''), 'https:']) {
    assert.equal(resolveBimcollabRoute(`docs/${guid}/projects`), null);
  }
});

test('BIMcollab relay: one DNS label shared with the OAuth token validator; positive safe integers', () => {
  for (const label of ['a', 'space-123', 'a'.repeat(63)]) {
    assert.ok(resolveBimcollabRoute(`space/${label}/download/42`));
    assert.ok(bimcollabTokenEndpoint(`https://${label}.bimcollab.com/identity/connect/token`));
  }
  for (const label of ['', '-space', 'space-', 'UPPER', 'a.b', 'a@b', 'a:443', 'a'.repeat(64)]) {
    assert.equal(resolveBimcollabRoute(`space/${label}/download/42`), null);
  }
  for (const id of ['0', '-1', '1.5', '1e2', '01', '9007199254740992']) {
    assert.equal(resolveBimcollabRoute(`space/valid/download/${id}`), null);
  }
});

test('BIMcollab relay: bearer mandatory and methods bounded before fetching', async () => {
  const { handler, calls } = fixture();
  for (const value of ['', 'Basic fake', 'Bearer', 'Bearer a b']) {
    assert.equal((await handler(request(undefined, { headers: { authorization: value } }))).status, 401);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await handler(request(undefined, { method }))).status, 405);
  assert.equal(calls.length, 0);
});

test('BIMcollab relay: explicit header allowlists, original query and rewritten path; HEAD', async () => {
  const { handler, calls } = fixture(() => new Response('file', { headers: {
    'set-cookie': 'secret=1', 'x-private': 'hidden', 'content-disposition': 'attachment; filename="a.ifc"',
    'content-length': '4', etag: 'v1', 'last-modified': 'today', 'content-type': 'model/ifc',
  } }));
  const result = await handler(request(`?path=${DOCS}/projects&q=a%20b&limit=1`, {
    headers: { cookie: 'browser=1', 'x-private': 'hidden', 'bimcollab-space-guid': 'wrong' },
  }));
  assert.equal(calls[0].url, `https://api.eu.bimcollab.com/spaces/${GUID}/documents/v1/projects?q=a%20b&limit=1`);
  assert.deepEqual([...calls[0].headers.keys()].sort(), ['accept', 'authorization', 'bimcollab-space-guid']);
  assert.equal(calls[0].headers.get('bimcollab-space-guid'), GUID);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('x-private'), null);
  assert.equal(result.headers.get('content-disposition'), 'attachment; filename="a.ifc"');
  for (const name of ['content-type', 'content-length', 'etag', 'last-modified']) assert.ok(result.headers.get(name));
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const head = await handler(request('space/test/download/42', { method: 'HEAD' }));
  assert.equal(head.body, null);
  assert.equal(calls[1].init.method, 'HEAD');
  for (const path of [`${DOCS}/projects%2fextra`, `?path=docs%2f${GUID}%2fprojects%252fextra`,
    `?path=docs%2f${GUID}%2fprojects%2f..%2fdocuments`, `?path=docs%2f${GUID}%2fprojects%5cx`]) {
    assert.equal((await handler(request(path))).status, 400, path);
  }
});

test('BIMcollab relay: accepts the path exactly as the Vercel rewrite encodes it', async () => {
  // vercel.json rewrites /api/bimcollab/:path* to /api/bimcollab?path=:path*,
  // which percent-encodes every slash of the captured path (measured on Vercel's
  // routing-utils); rejecting %2F here would refuse every production request.
  const { handler, calls } = fixture();
  const response = await handler(new Request(`${ORIGIN}/api/bimcollab?path=docs%2F${GUID}%2Fprojects%2Fp1%2Fdocuments&limit=100&offset=0`, {
    headers: { authorization: 'Bearer fake-token' },
  }));
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, `https://api.eu.bimcollab.com/spaces/${GUID}/documents/v1/projects/p1/documents?limit=100&offset=0`);
  const download = fixture(() => new Response('PK'));
  const file = await download.handler(new Request(`${ORIGIN}/api/bimcollab?path=space%2Fbusa%2Fdownload%2F109`, {
    headers: { authorization: 'Bearer fake-token' },
  }));
  assert.equal(file.status, 200);
  assert.equal(download.calls[0].url, 'https://busa.bimcollab.com/documents/da/location/0/project/0/documentinstance/download/109');
});

test('BIMcollab relay: origins, explicit override, preflight', async () => {
  assert.deepEqual(loadBimcollabRelayConfig({}).allowedOrigins, [ORIGIN, 'http://localhost:5000']);
  assert.deepEqual(loadBimcollabRelayConfig({ APP_URL: 'https://preview.test' }).allowedOrigins, ['https://preview.test', ORIGIN, 'http://localhost:5000']);
  assert.deepEqual(loadBimcollabRelayConfig({ BIMCOLLAB_RELAY_ALLOWED_ORIGINS: ' https://only.test, ' }).allowedOrigins, ['https://only.test']);
  const { handler, calls } = fixture();
  for (const method of ['GET', 'OPTIONS']) {
    const good = await handler(request(undefined, { method, headers: { origin: ORIGIN } }));
    assert.equal(good.status, method === 'OPTIONS' ? 204 : 200);
    assert.equal(good.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(good.headers.get('access-control-allow-headers') ?? '', /Authorization/);
    const bad = await handler(request(undefined, { method, headers: { origin: 'https://evil.test' } }));
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(calls.length, 1);
});

test('BIMcollab relay: off-host redirects rejected, login mapped to 401, same-origin followed manually', async () => {
  for (const location of ['https://evil.test/file', '//evil.test/file', 'http://test.bimcollab.com/file', 'https://user@test.bimcollab.com/file']) {
    const { handler, calls } = fixture(() => new Response(null, { status: 302, headers: { location } }));
    assert.equal((await handler(request('space/test/download/42'))).status, 502);
    assert.equal(calls.length, 1);
  }
  for (const location of ['/Identity/Account/Login?returnUrl=foo', '/identity/login', '/documents/Identity/Account/Login?ReturnUrl=%2Fdocuments%2Fda']) {
    const { handler } = fixture(() => new Response(null, { status: 302, headers: { location } }));
    const response = await handler(request('space/test/download/42'));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'unauthorized');
  }
  const { handler, calls } = fixture(url => url.endsWith('/42')
    ? new Response(null, { status: 302, headers: { location: '/file' } }) : new Response('file'));
  assert.equal(await (await handler(request('space/test/download/42'))).text(), 'file');
  assert.equal(calls.length, 2);
});

test('BIMcollab relay: downloads return the exact stream without reading a chunk', async () => {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    reads++; controller.enqueue(new TextEncoder().encode('chunk')); controller.close();
  } }, { highWaterMark: 0 });
  const { handler } = fixture(() => new Response(stream));
  const response = await handler(request('space/test/download/42'));
  assert.equal(response.body, stream);
  assert.equal(reads, 0);
  assert.equal(await response.text(), 'chunk');
  assert.equal(reads, 1);
});

function document(id: number) {
  return { id, documentNumber: 'DOC', allowDownload: true, secret: 'drop',
    attachedToLocation: { id: 2, name: 'Location', secret: 'drop' },
    attachedToProject: null, attachedToProjectPhase: { id: 3, name: 'Phase' },
    latestVersion: { id: id + 100, versionNumber: 4, originalFileName: 'model.ifc', secret: 'drop' } };
}

test('BIMcollab relay: index fixed POST pages merge and project only approved fields', async () => {
  const { handler, calls } = fixture((_url, init) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body, { columns: [], search: { regex: false, value: '' }, order: [], draw: 0,
      start: calls.length === 1 ? 0 : 500, length: 500, locationId: 2, projectId: 7,
      showForSpecificSelectionOnly: false, ignoreUserState: true });
    assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
    return Response.json({ recordsTotal: 501, data: calls.length === 1 ? Array.from({ length: 500 }, (_, i) => document(i)) : [document(500)] });
  });
  const response = await handler(request('space/test/index?locationId=2&projectId=7'));
  assert.equal(response.status, 200);
  const { records } = await response.json();
  assert.equal(records.length, 501);
  assert.equal(records[500].documentId, 500);
  assert.deepEqual(records[0], { documentId: 0, documentNumber: 'DOC', versionNumber: '4', versionId: 100,
    fileName: 'model.ifc', allowDownload: true, locationId: 2, locationName: 'Location',
    projectId: null, projectName: null, projectPhaseName: 'Phase' });
  assert.equal(calls.length, 2);
});

test('BIMcollab relay: index caps at 5000, omits absent project, refuses caller-supplied pagination', async () => {
  const { handler, calls } = fixture((_url, init) => {
    assert.equal('projectId' in JSON.parse(String(init.body)), false);
    return Response.json({ recordsTotal: 99999, data: Array.from({ length: 500 }, (_, i) => document(i)) });
  });
  const response = await handler(request('space/test/index?locationId=2'));
  assert.equal((await response.json()).records.length, 5000);
  assert.equal(calls.length, 10);
  for (const query of ['', '?locationId=0', '?locationId=2&start=0', '?locationId=2&projectId=-1', '?locationId=2&locationId=3']) {
    assert.equal((await handler(request(`space/test/index${query}`))).status, 400);
  }
  assert.equal((await handler(request('space/test/index?locationId=2', { method: 'HEAD' }))).status, 405);
  assert.equal(calls.length, 10);
});

test('BIMcollab relay: upstream 404 detail unchanged, bounded errors and malformed pages fail safely', async () => {
  const detail = '"No download URL available for this document"';
  const { handler } = fixture(() => new Response(detail, { status: 404, headers: { 'set-cookie': 'secret=1' } }));
  const response = await handler(request(`${DOCS}/documents/id/download`));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'upstream_error', detail });
  assert.equal(response.headers.get('set-cookie'), null);
  const malformed = fixture(() => Response.json({ recordsTotal: 10, data: [] }));
  assert.equal((await malformed.handler(request('space/test/index?locationId=2'))).status, 502);
  const huge = fixture(() => new Response('x'.repeat(10000), { status: 503 }));
  assert.equal((await (await huge.handler(request())).json()).detail.length, 4096);
});

test('BIMcollab relay: an HTML 200 on a download is a login page, never a model', async () => {
  const { handler } = fixture(() => new Response('<!DOCTYPE html><title>Login</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  const response = await handler(request('space/test/download/42'));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'unauthorized');
  // Documents API JSON is unaffected by the download-only guard.
  const docs = fixture(() => new Response('<p>odd</p>', { headers: { 'content-type': 'text/html' } }));
  assert.equal((await docs.handler(request())).status, 200);
});

test('BIMcollab relay: a version-less index record is skipped, the rest still listed', async () => {
  const broken = { ...document(1), latestVersion: null };
  const { handler } = fixture(() => Response.json({ recordsTotal: 2, data: [document(0), broken] }));
  const response = await handler(request('space/test/index?locationId=2'));
  assert.equal(response.status, 200);
  const { records } = await response.json();
  assert.deepEqual(records.map((r: { documentId: number }) => r.documentId), [0]);
});
