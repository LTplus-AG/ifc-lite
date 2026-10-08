/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSemanticProvider } from './provider.js';
import { createSemanticRelay } from './server.js';
import { exportWorkspace, importWorkspace } from './workspace.js';
let server: Server; let origin: string; let onCancellationRequest: (() => void) | undefined;
beforeAll(async () => {
  server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/select' }).end(); return; }
    if (request.url === '/cancel') { onCancellationRequest?.(); setTimeout(() => response.end('{}'), 100); return; }
    if (request.url === '/slow') { setTimeout(() => response.end('{}'), 100); return; }
    if (request.url === '/large') { response.end('x'.repeat(1000)); return; }
    if (body.includes('CONSTRUCT')) { response.setHeader('Content-Type', 'text/turtle'); response.end('<urn:original> <urn:label> "original loopback graph" .'); return; }
    response.setHeader('Content-Type', 'application/sparql-results+json');
    response.end(JSON.stringify({ head: { vars: ['label'] }, results: { bindings: [{ label: { type: 'literal', value: 'original local result', 'xml:lang': 'en' } }] } }));
  }).listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
const provider = createSemanticProvider();
function options(path = '/select') { return { endpoint: `${origin}${path}`, host: '127.0.0.1', loopbackHttpOrigin: origin, kind: 'select' as const, query: 'SELECT * WHERE {?s ?p ?o}' }; }
describe('real loopback HTTP shared provider #6784', () => {
  it('preserves actual SELECT terms and CONSTRUCT graph without TLS', async () => {
    const selected = await provider.read(options()); expect(selected.kind).toBe('select');
    if (selected.kind === 'select') expect(selected.value.rows[0].label).toMatchObject({ value: 'original local result', 'xml:lang': 'en' });
    const graph = await provider.read({ ...options(), kind: 'construct', query: 'CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o}' });
    expect(graph.kind).toBe('construct'); if (graph.kind === 'construct') expect(graph.quadCount).toBe(1);
  });
  it('refuses redirects, bounded overflow, timeouts and cancelled reads', async () => {
    await expect(provider.read(options('/redirect'))).rejects.toThrow('redirect');
    await expect(provider.read({ ...options('/large'), maxBytes: 50 })).rejects.toThrow('limit');
    await expect(provider.read({ ...options('/slow'), timeoutMs: 10 })).rejects.toThrow();
    const controller = new AbortController();
    const arrived = new Promise<void>(resolve => { onCancellationRequest = resolve; });
    const pending = provider.read(options('/cancel'), controller.signal);
    await arrived; controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    onCancellationRequest = undefined;
  });
  it('imports an inert endpoint while stripping HTTP authority and denies its subsequent ungranted read', async () => {
    const workspace = { version: 1 as const, datasets: [], revisions: [], queries: [{ id: 'local', endpoint: `${origin}/select`, kind: 'select' as const, query: options().query, loopbackHttpOrigin: origin }] };
    const saved = exportWorkspace(workspace); expect(saved).not.toContain('loopbackHttpOrigin');
    const loaded = importWorkspace(saved); expect(loaded.grants).toEqual([]);
    const query = loaded.workspace.queries[0]; expect(query.endpoint).toBe(`${origin}/select`);
    await expect(provider.read({ ...query, host: '127.0.0.1' })).rejects.toThrow();
  });
  it('keeps relay clients on authenticated HTTPS while a fixed host-configured upstream uses HTTP', async () => {
    const token = 'original-loopback-client-token-with-32-characters';
    const relay = createSemanticRelay({ clientToken: token, allowedOrigins: [], providers: { local: { endpoint: `${origin}/select`, grantedHost: '127.0.0.1', kind: 'sparql', loopbackHttpOrigin: origin } } });
    const request = (endpoint: string, extra = {}) => new Request(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: 'local', kind: 'select', query: options().query, ...extra }) });
    expect((await relay(request('https://relay.example.org'))).status).toBe(200);
    expect((await relay(request('http://localhost'))).status).toBe(400);
    expect((await relay(request('https://relay.example.org', { loopbackHttpOrigin: origin }))).status).toBe(400);
    const invalid = { clientToken: token, allowedOrigins: [], providers: { local: { endpoint: `${origin}/select`, grantedHost: '127.0.0.1', kind: 'sparql' as const } } };
    expect(() => createSemanticRelay(invalid)).toThrow('https');
  });
});
