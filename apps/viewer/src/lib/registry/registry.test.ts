/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegistryTransport, RegistryError, repositoryName, releaseName } from './transport';
import { RegistryArtifacts, OCI_MANIFEST_TYPE, sha256 } from './artifacts';

test('registry references cannot escape their repository and SHA-256 uses actual bytes', async () => {
  for (const value of ['../private', 'Project/model', 'project//model', 'project/model?token=x']) assert.throws(() => repositoryName(value));
  for (const value of ['../issued', 'tag?x', '-bad']) assert.throws(() => releaseName(value));
  assert.equal(await sha256(new TextEncoder().encode('abc')), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.throws(() => new RegistryTransport('http://remote.example.com'));
});

test('a challenge cannot send sign-in credentials to another origin', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="https://elsewhere.example/token",service="test"' }); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const transport = new RegistryTransport(`http://127.0.0.1:${address.port}`);
    await assert.rejects(transport.login('project/model', 'writer', 'unused-test-password'), /another address/);
    assert.equal(transport.session, null);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('an IFC blob with the expected size but different bytes is refused', async () => {
  const original = new TextEncoder().encode('ISO-10303-21; original');
  const changed = new TextEncoder().encode('ISO-10303-21; modified');
  assert.equal(original.length, changed.length);
  const layer = { mediaType: 'application/x-step', digest: await sha256(original), size: original.length };
  const raw = JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST_TYPE, config: layer, layers: [layer] });
  const digest = await sha256(new TextEncoder().encode(raw));
  const server = createServer((request, response) => {
    if (request.url === '/v2/') {
      response.writeHead(401, { 'WWW-Authenticate': `Bearer realm="http://${request.headers.host}/token",service="test"` }); response.end();
    } else if (request.url?.startsWith('/token')) {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ token: 'test-only', expires_in: 900, access: [{ type: 'repository', name: 'project/model', actions: ['pull'] }] }));
    } else if (request.url?.includes('/manifests/')) {
      response.setHeader('Docker-Content-Digest', digest); response.end(raw);
    } else { response.end(changed); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const transport = new RegistryTransport(`http://127.0.0.1:${address.port}`);
    await transport.login('project/model', 'reader', 'unused-test-password');
    await assert.rejects(new RegistryArtifacts(transport).pull('project/model', 'issued'), /integrity check/);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('real Rust registry accepts browser artifacts, preserves IFC bytes, and enforces scopes; ORAS reads the result', { timeout: 30000 }, async context => {
  const binary = process.env.IFCX_OCI_BINARY;
  if (!binary) { context.skip('Set IFCX_OCI_BINARY to run against the Rust registry.'); return; }
  const root = await mkdtemp(join(tmpdir(), 'ifclite-registry-'));
  const password = 'test-only-registry-password';
  const data = join(root, 'store');
  for (const [name, grant] of [['writer', 'project/model:pull,push'], ['reader', 'project/model:pull']]) {
    execFileSync(binary, ['user', 'add', '--data', data, name, '--grant', grant, '--password-stdin'], { input: password, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  const server = spawn(binary, ['serve', '--data', data, '--listen', '127.0.0.1:0'], { stdio: ['ignore', 'ignore', 'pipe'] });
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
    const writer = new RegistryTransport(origin);
    const session = await writer.login('project/model', 'writer', password);
    assert.deepEqual(session.actions.sort(), ['pull', 'push']);
    const artifacts = new RegistryArtifacts(writer);
    const source = new Uint8Array(await readFile(new URL('../../../public/samples/hello-wall.ifc', import.meta.url)));
    const digest = await artifacts.publish('project/model', 'first', source, 'model.ifc');
    const pulled = await artifacts.pull('project/model', digest);
    assert.equal(pulled.digest, digest); assert.deepEqual(pulled.bytes, source);
    assert.deepEqual(await artifacts.tags('project/model'), ['first']);
    await assert.rejects(artifacts.publish('project/model', 'first', source, 'model.ifc'), /already exists/);
    const reader = new RegistryTransport(origin);
    assert.deepEqual((await reader.login('project/model', 'reader', password)).actions, ['pull']);
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
    writer.logout(); assert.equal(writer.session, null);
    await assert.rejects(artifacts.tags('project/model'), (error: unknown) => error instanceof RegistryError && error.status === 401);
  } finally {
    server.kill('SIGTERM'); await new Promise<void>(resolve => server.once('exit', () => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
