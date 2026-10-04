/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6643: exercise the Node HTTPS adapter with a real trusted test CA, not an insecure HTTP production path. */
import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createSemanticRelayServer } from './server-listener.js';

it('HTTPS listener preserves POST auth/body and rejects unauthorized callers #6643', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ifc-lite-relay-tls-'));
  let server: ReturnType<typeof createSemanticRelayServer> | undefined;
  try {
    const certFile = join(directory, 'cert.pem'); const keyFile = join(directory, 'key.pem');
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
    const cert = await readFile(certFile); const key = await readFile(keyFile);
    const clientToken = 'tls-client-test-token-with-32-characters-minimum';
    let upstreamCalls = 0;
    server = createSemanticRelayServer({ clientToken, allowedOrigins: [], providers: { records: {
      endpoint: 'https://provider.example.org/records', grantedHost: 'provider.example.org', kind: 'json' } },
      transport: async (url, init) => {
        // The bytes crossing this adapter came from a real TLS client; assert the provider authority invariant.
        expect(url.hostname).toBe('provider.example.org'); expect(init.method).toBe('GET'); upstreamCalls++;
        return new Response('{"id":"https://example.org/tls-original"}', { headers: { 'Content-Type': 'application/json' } });
      } }, { cert, key }).listen(0, '127.0.0.1');
    await once(server, 'listening'); const port = (server.address() as AddressInfo).port;
    const call = async (token: string) => {
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const body = JSON.stringify({ providerId: 'records', kind: 'json' });
        const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/semantic', ca: cert,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
          let received = ''; res.setEncoding('utf8'); res.on('data', chunk => { received += String(chunk); });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: received })); res.on('error', reject);
        }); req.on('error', reject); req.end(body);
      });
    };
    expect(await call(clientToken)).toEqual({ status: 200, body: '{"id":"https://example.org/tls-original"}' });
    expect((await call('wrong')).status).toBe(401); expect(upstreamCalls).toBe(1);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

it('answers a request target `new URL` rejects with 400, not 500', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ifc-lite-relay-target-'));
  let server: ReturnType<typeof createSemanticRelayServer> | undefined;
  try {
    const certFile = join(directory, 'cert.pem'); const keyFile = join(directory, 'key.pem');
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
    const cert = await readFile(certFile); const key = await readFile(keyFile);
    server = createSemanticRelayServer({ clientToken: 'tls-client-test-token-with-32-characters-minimum', allowedOrigins: [], providers: {} }, { cert, key }).listen(0, '127.0.0.1');
    await once(server, 'listening'); const port = (server.address() as AddressInfo).port;
    // `//` is the shortest request-target that `new URL('//', base)` rejects.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'GET', path: '//', ca: cert }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(400);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

