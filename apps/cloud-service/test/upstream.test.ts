/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { CloudSessions } from '../src/sessions.js';
import { downloadBytes, requestJson } from '../src/upstream.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const origin = 'https://viewer.example';
const downloadDirectory = join(tmpdir(), `ifclite-cloud-upstream-tests-${process.pid}`);
it('Graph download never sends credentials to signed destinations and checks exact current revision (#6840)', async () => {
  const requests: { url: string; bearer: string | null }[] = []; let metadataCalls = 0;
  const sessions = new CloudSessions({ origin, apps: {}, downloadDirectory, fetch: async (input, init) => {
    const url = String(input); requests.push({ url, bearer: new Headers(init?.headers).get('authorization') });
    if (new URL(url).searchParams.has('$select')) { metadataCalls++; return Response.json({ id: 'file', cTag: 'current', eTag: 'etag' }); }
    if (url.endsWith('/content')) return new Response(null, { status: 302, headers: { location: 'https://tenant.sharepoint.com/model' } });
    return new Response('ISO-10303-21;');
  } });
  const session = sessions.create('msgraph'); session.token = { access: 'private-access', expires: Date.now() + 3600_000 };
  const file = await downloadBytes(sessions, session, { path: '/me/drive/items/file/content', revision: 'current' }, AbortSignal.timeout(1000));
  expect(await new Response(file.stream).text()).toBe('ISO-10303-21;'); await file.dispose();
  expect(metadataCalls).toBe(2); expect(requests.find(r => r.url.includes('sharepoint'))?.bearer).toBeNull();
  expect(requests.filter(r => r.url.includes('graph.microsoft')).every(r => r.bearer === 'Bearer private-access')).toBe(true);
  await expect(downloadBytes(sessions, session, { path: '/me/drive/items/file/content', revision: 'etag' }, AbortSignal.timeout(1000))).rejects.toThrow('changed'); sessions.close();
});
it('rejects a file changing during transfer before exposing its bytes (#6840)', async () => {
  let calls = 0;
  const sessions = new CloudSessions({ origin, apps: {}, downloadDirectory, fetch: async (input) => {
    const url = String(input);
    if (new URL(url).searchParams.has('$select')) return Response.json({ cTag: ++calls === 1 ? 'v1' : 'v2' });
    if (url.endsWith('/content')) return new Response(null, { status: 302, headers: { location: 'https://tenant.sharepoint.com/file' } });
    return new Response('unqualified bytes');
  } });
  const session = sessions.create('msgraph'); session.token = { access: 'token', expires: Date.now() + 3600_000 };
  await expect(downloadBytes(sessions, session, { path: '/me/drive/items/file/content', revision: 'v1' }, AbortSignal.timeout(1000))).rejects.toThrow('during download'); sessions.close();
});
it('blocks malicious Microsoft download redirects without contacting destination (#6840)', async () => {
  let calls = 0; const sessions = new CloudSessions({ origin, apps: {}, downloadDirectory, fetch: async (input) => {
    calls++; return new URL(String(input)).searchParams.has('$select') ? Response.json({ cTag: 'v1' }) : new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
  } });
  const session = sessions.create('msgraph'); session.token = { access: 'token', expires: Date.now() + 3600_000 };
  await expect(downloadBytes(sessions, session, { path: '/me/drive/items/file/content', revision: 'v1' }, AbortSignal.timeout(1000))).rejects.toThrow('destination'); expect(calls).toBe(2); sessions.close();
});
it('permits the exact existing read paths while stripping authenticated download metadata (#6840)', async () => {
  const paths: string[] = []; const sessions = new CloudSessions({ origin, apps: {}, downloadDirectory, fetch: async (input) => {
    paths.push(new URL(String(input)).pathname); return Response.json({ value: [{ id: 'file', '@microsoft.graph.downloadUrl': 'private-link' }] });
  } });
  const session = sessions.create('msgraph'); session.token = { access: 'token', expires: Date.now() + 3600_000 };
  for (const path of ['/me/drive', '/me/drive/root/children', '/me/drive/items/file/children', "/me/drive/root/search(q='model')", '/me/drive/items/file/versions', '/me/drive/root/delta']) {
    const result = await requestJson(sessions, session, { path }, AbortSignal.timeout(1000)); expect(JSON.stringify(result)).not.toContain('private-link');
  }
  expect(paths).toHaveLength(6); sessions.close();
});
