/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Window } from 'happy-dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegistryTransport } from './transport';
import { RegistryError, repositoryName, releaseName, REGISTRY_REFRESH_COOKIE, type RegistrySession } from './protocol';
import { RegistryArtifacts, OCI_MANIFEST_TYPE, sha256 } from './artifacts';
import { approveRegistryLogin, installRegistryPopup, registryCallback, registryOAuthConfig, registryTokenReply } from '@/test/registry-oauth-fixture';
import { REGISTRY_CALLBACK_PATH } from './oauth';

// Keep Node's real HTTP fetch for the server integration; only popup/HTML parsing need a DOM.
const browserWindow = new Window({ url: 'http://localhost/' });
Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow });
Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: browserWindow.DOMParser });

test('registry references cannot escape their repository and SHA-256 uses actual bytes', async () => {
  for (const value of ['../private', 'Project/model', 'project//model', 'project/model?token=x']) assert.throws(() => repositoryName(value));
  for (const value of ['../issued', 'tag?x', '-bad']) assert.throws(() => releaseName(value));
  assert.equal(await sha256(new TextEncoder().encode('abc')), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.throws(() => new RegistryTransport('http://remote.example.com'));
});

test('an IFC blob with the expected size but different bytes is refused', async () => {
  const original = new TextEncoder().encode('ISO-10303-21; original');
  const changed = new TextEncoder().encode('ISO-10303-21; modified');
  assert.equal(original.length, changed.length);
  const layer = { mediaType: 'application/x-step', digest: await sha256(original), size: original.length };
  const raw = JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST_TYPE, config: layer, layers: [layer] });
  const digest = await sha256(new TextEncoder().encode(raw));
  const server = createServer((request, response) => {
    if (request.url === '/oauth/config') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(registryOAuthConfig(`http://${request.headers.host}`)));
    } else if (request.url === '/oauth/token') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(registryTokenReply('reader', ['pull'])));
    } else if (request.url?.includes('/manifests/')) {
      response.setHeader('Docker-Content-Digest', digest); response.end(raw);
    } else { response.end(changed); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const popup = installRegistryPopup(registryCallback);
  let transport: RegistryTransport | undefined;
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    transport = new RegistryTransport(origin, origin);
    await transport.login('project/model');
    await assert.rejects(new RegistryArtifacts(transport).pull('project/model', 'issued'), /integrity check/);
  } finally { transport?.logout(); popup.restore(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('real registry PKCE login preserves IFC bytes and scopes; ORAS reads the published artifact (#8310)', { timeout: 30000 }, async context => {
  const binary = process.env.IFCX_OCI_BINARY;
  if (!binary) { context.skip('Set IFCX_OCI_BINARY to run against the Rust registry.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'ifclite-registry-'));
  const password = 'test-only-registry-password';
  const data = join(root, 'store');
  for (const [name, grant] of [['writer', 'project/model:pull,push'], ['reader', 'project/model:pull']]) {
    execFileSync(binary, ['user', 'add', '--data', data, name, '--grant', grant, '--password-stdin'], { input: password, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  const server = spawn(binary, ['serve', '--data', data, '--listen', '127.0.0.1:0', '--oauth-client-id', 'ifc-lite', '--oauth-redirect-uri', `${window.location.origin}${REGISTRY_CALLBACK_PATH}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let signingIn = 'writer';
  let remember = false;
  const popup = installRegistryPopup(request => approveRegistryLogin(request, signingIn, password, remember));
  const clients = new Set<RegistryTransport>();
  const client = (origin: string, onSession?: (session: RegistrySession | null) => void) => { const transport = new RegistryTransport(origin, origin, onSession); clients.add(transport); return transport; };
  const originalFetch = globalThis.fetch;
  let registryOrigin = ''; let cookie = ''; let lastBearer = ''; let memoryRenewals = 0;
  // Test-only browser cookie jar: production JavaScript never reads the HttpOnly refresh cookie.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== registryOrigin) return originalFetch(input, init);
    if (url.pathname.startsWith('/v2/')) lastBearer = new Headers(init?.headers).get('Authorization') ?? '';
    if (!['/oauth/token', '/oauth/revoke'].includes(url.pathname)) return originalFetch(input, init);
    const headers = new Headers(init?.headers); headers.set('Origin', window.location.origin);
    if (init?.credentials === 'include' && cookie) headers.set('Cookie', cookie);
    const body = new URLSearchParams(String(init?.body));
    if (body.get('grant_type') === 'refresh_token' && body.has('refresh_token')) memoryRenewals++;
    const response = await originalFetch(input, { ...init, headers });
    if (init?.credentials === 'include') for (const header of response.headers.getSetCookie()) {
      if (!header.startsWith(`${REGISTRY_REFRESH_COOKIE}=`)) continue;
      assert.match(header, /HttpOnly/i); assert.match(header, /SameSite=Strict/i); assert.match(header, /Path=\/oauth\//);
      const assignment = header.split(';')[0]; cookie = assignment === `${REGISTRY_REFRESH_COOKIE}=` ? '' : assignment;
    }
    if (response.ok && url.pathname === '/oauth/token') {
      const body: unknown = await response.clone().json();
      if (body && typeof body === 'object' && 'remember_me' in body && body.remember_me) assert.equal('refresh_token' in body, false);
    }
    return response;
  };
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('Registry did not start')), 5000);
      server.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString(); const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timeout); resolve(match[0]); }
      });
      server.on('error', error => { clearTimeout(timeout); reject(error); });
    });
    registryOrigin = origin;
    const writer = client(origin);
    const session = await writer.login('project/model');
    assert.deepEqual(session.actions.sort(), ['pull', 'push']);
    const artifacts = new RegistryArtifacts(writer);
    const source = new Uint8Array(await readFile(new URL('../../../public/samples/hello-wall.ifc', import.meta.url)));
    const digest = await artifacts.publish('project/model', 'first', source, 'model.ifc');
    const discovery = client(origin);
    await discovery.login(null);
    const browser = new RegistryArtifacts(discovery);
    const catalog = await browser.modelCatalog();
    assert.deepEqual(catalog.repositories, ['project/model']);
    assert.equal(catalog.titles['project/model'], 'model');
    const info = await browser.describe('project/model', 'first');
    assert.equal(info.publisher, 'writer');
    assert.equal(info.declaredAuthors, 'writer');
    assert(info.pushedAt && Math.abs(Date.now() / 1000 - info.pushedAt) < 30);
    assert(info.createdAt && Number.isFinite(Date.parse(info.createdAt)));
    const pulled = await artifacts.pull('project/model', digest);
    assert.equal(pulled.digest, digest); assert.deepEqual(pulled.bytes, source);
    assert.deepEqual(await artifacts.tags('project/model'), ['first']);
    await assert.rejects(artifacts.publish('project/model', 'first', source, 'model.ifc'), /already exists/);
    const reader = client(origin);
    signingIn = 'reader';
    assert.deepEqual((await reader.login('project/model')).actions, ['pull']);
    assert.equal((await new RegistryArtifacts(reader).pull('project/model', 'first')).digest, digest);
    await assert.rejects(new RegistryArtifacts(reader).publish('project/model', 'denied', source, 'model.ifc'), (error: unknown) => error instanceof RegistryError && error.status === 403);
    await assert.rejects(reader.request('/v2/project/model/manifests/denied', { method: 'PUT', body: '{}' }), (error: unknown) => error instanceof RegistryError && error.status === 403);
    await assert.rejects(reader.request('/v2/private/model/tags/list'), (error: unknown) => error instanceof RegistryError && error.status === 403);
    const oras = process.env.IFCX_ORAS_BINARY;
    if (oras) {
      const config = join(root, 'oras-auth.json'); const host = new URL(origin).host;
      execFileSync(oras, ['login', '--plain-http', '--registry-config', config, host, '--username', 'writer', '--password-stdin'], { input: password, stdio: ['pipe', 'pipe', 'pipe'] });
      const manifest = execFileSync(oras, ['manifest', 'fetch', '--plain-http', '--registry-config', config, `${host}/project/model@${digest}`]);
      assert.equal(await sha256(manifest), digest);
      const output = join(root, 'received');
      execFileSync(oras, ['pull', '--plain-http', '--registry-config', config, '--output', output, `${host}/project/model@${digest}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      assert.deepEqual(new Uint8Array(await readFile(join(output, 'model.ifc'))), source);
    } else { context.diagnostic('ORAS check skipped: set IFCX_ORAS_BINARY.'); }
    let now = Date.now(); context.mock.method(Date, 'now', () => now);
    const deadline = writer.session?.sessionExpiresAt;
    now += 901000;
    await (await writer.request('/v2/project/model/tags/list')).json();
    assert.equal(memoryRenewals, 1); assert.equal(writer.session?.sessionExpiresAt, deadline);

    signingIn = 'writer'; remember = true;
    const remembered = client(origin);
    const rememberedSession = await remembered.login(null);
    assert(rememberedSession.remembered); assert(cookie);
    assert(rememberedSession.sessionExpiresAt - now > 29 * 24 * 3600 * 1000);
    let cleared!: () => void; const notified = new Promise<void>(resolve => { cleared = resolve; });
    const anotherTab = client(origin, session => { if (!session) cleared(); });
    assert.equal((await anotherTab.restore())?.sessionExpiresAt, rememberedSession.sessionExpiresAt);
    await (await anotherTab.request('/v2/project/model/tags/list')).json();
    const rememberedAccess = lastBearer;
    await writer.signOut(); assert(cookie, 'signing out an independent memory session leaves remembered tabs connected');
    await remembered.signOut(); await notified;
    assert.equal(cookie, ''); assert.equal(anotherTab.session, null);
    assert.equal((await originalFetch(`${origin}/v2/project/model/tags/list`, { headers: { Authorization: rememberedAccess } })).status, 401);
    assert.equal(await client(origin).restore(), null, 'a fresh tab cannot restore after server revocation');
    assert(reader.can('pull'), 'an independent tab-only session remains valid');
    assert.equal(writer.session, null);
    await assert.rejects(artifacts.tags('project/model'), (error: unknown) => error instanceof RegistryError && error.status === 401);
    assert.deepEqual(popup.errors, []);
  } finally {
    globalThis.fetch = originalFetch;
    for (const transport of clients) transport.logout();
    popup.restore();
    server.kill('SIGTERM'); await new Promise<void>(resolve => server.once('exit', () => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
