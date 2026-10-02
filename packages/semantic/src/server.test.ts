/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6643: the real relay enforces authority before a transport moves any bytes. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createSemanticRelay } from './server.js';
import { createSemanticProvider } from './provider.js';
import type { FetchTransport } from '@ifc-lite/sandbox/network';
const clientToken = 'client-test-token-with-at-least-32-characters';
const upstreamToken = 'upstream-test-token-with-at-least-32-characters';
const origin = 'https://viewer.example.org';
let server: Server; let base: string; const received: { path?: string; method?: string; auth?: string; body: string }[] = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    received.push({ path: req.url, method: req.method, auth: req.headers.authorization, body });
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/json' }).end(); return; }
    if (req.url === '/slow') { setTimeout(() => res.end('{}'), 100); return; }
    if (req.url === '/secret-error') { res.writeHead(401).end(upstreamToken); return; }
    res.setHeader('Content-Type', req.url === '/graph' ? 'text/turtle' : 'application/json');
    if (req.url === '/secret-echo') { res.end(JSON.stringify({ credential: upstreamToken })); return; }
    if (req.url === '/oversized') { res.end('x'.repeat(1000)); return; }
    if (req.url === '/graph') { res.end('<https://example.org/s> <https://example.org/p> "bonjour"@fr .'); return; }
    if (req.url === '/select') { res.end(JSON.stringify({ head: { vars: ['s', 'label', 'optional'] }, results: { bindings: [
      { s: { type: 'uri', value: 'https://example.org/s' }, label: { type: 'literal', value: 'bonjour', 'xml:lang': 'fr' } },
      { s: { type: 'bnode', value: 'blank' }, label: { type: 'literal', value: '3', datatype: 'http://www.w3.org/2001/XMLSchema#integer' } },
    ] } })); return; }
    res.end('{"resources":[{"id":"https://example.org/product"}]}');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening'); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
const transport: FetchTransport = (url, init) => fetch(`${base}${url.pathname}`, init);
function relay(path = '/json', extras = {}) { return createSemanticRelay({ clientToken, allowedOrigins: [origin],
  providers: { demo: { endpoint: `https://provider.example.org${path}`, grantedHost: 'provider.example.org', kind: path === '/select' || path === '/graph' ? 'sparql' : 'json', bearerToken: () => upstreamToken } }, transport, ...extras }); }
function request(body: unknown = { providerId: 'demo', kind: 'json' }, headers: Record<string, string> = {}) {
  return new Request('https://relay.example.org/semantic', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientToken}`, Origin: origin, ...headers }, body: JSON.stringify(body) });
}
describe('Authenticated relay #6643', () => {
  it('forwards JSON only to a preauthorized provider and separates upstream credentials', async () => {
    const result = await relay()(request()); expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ resources: [{ id: 'https://example.org/product' }] });
    expect(received.at(-1)).toMatchObject({ path: '/json', method: 'GET', auth: `Bearer ${upstreamToken}`, body: '' });
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe(origin); expect(result.headers.get('Cache-Control')).toBe('no-store');
  });
  it('preserves RDF literal metadata, blank nodes and unbound columns over actual SELECT transport', async () => {
    const result = await relay('/select')(request({ providerId: 'demo', kind: 'select', query: 'SELECT * WHERE {?s ?p ?o}' }));
    expect(result.status).toBe(200); const json = await result.json();
    expect(json.head.vars).toEqual(['s', 'label', 'optional']); expect(json.results.bindings[0].label['xml:lang']).toBe('fr');
    expect(json.results.bindings[1].s.type).toBe('bnode'); expect(json.results.bindings[1].label.datatype).toContain('#integer');
    expect(json.results.bindings[0]).not.toHaveProperty('optional');
    expect(new URLSearchParams(received.at(-1)!.body).get('query')).toBe('SELECT * WHERE {?s ?p ?o}');
  });
  it('passes CONSTRUCT graphs through the same provider and grammar checks', async () => {
    const result = await relay('/graph')(request({ providerId: 'demo', kind: 'construct', query: 'CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o}' }));
    expect(result.status).toBe(200); expect(result.headers.get('Content-Type')).toBe('text/turtle'); expect(await result.text()).toContain('"bonjour"@fr');
  });
  it('rejects unauthorized tokens, origins, destinations and mutations before contacting providers', async () => {
    const start = received.length; const handle = relay();
    expect((await handle(request(undefined, { Authorization: 'Bearer wrong' }))).status).toBe(401);
    expect((await handle(request(undefined, { Origin: 'https://viewer.example.org.evil.net' }))).status).toBe(403);
    expect((await handle(request({ providerId: 'missing', kind: 'json' }))).status).toBe(404);
    expect((await handle(request({ providerId: 'demo', kind: 'json', endpoint: 'https://evil.net' }))).status).toBe(400);
    for (const query of ['INSERT DATA { <https://x> <https://p> <https://y> }', 'SELECT * WHERE { SERVICE <https://evil.net> {?s ?p ?o} }', 'SELECT * FROM <https://evil.net/g> WHERE {?s ?p ?o}']) {
      expect((await relay('/select')(request({ providerId: 'demo', kind: 'select', query }))).status).toBe(400);
    }
    expect(received.length).toBe(start);
  });
  it('rejects HTTP and embedded URL credentials at configuration boundaries', async () => {
    for (const endpoint of ['http://provider.example.org', 'https://user:secret@provider.example.org']) {
      expect(() => createSemanticRelay({ clientToken, allowedOrigins: [], providers: { demo: { endpoint, grantedHost: 'provider.example.org', kind: 'json' } } })).toThrow();
    }
    const result = await relay()(new Request('http://relay.example.org', { method: 'POST' })); expect(result.status).toBe(400);
  });
  it('allows precise CORS preflight without granting access to data', async () => {
    const result = await relay()(new Request('https://relay.example.org', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } }));
    expect(result.status).toBe(204); expect(result.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    expect((await relay()(new Request('https://relay.example.org', { method: 'OPTIONS' }))).status).toBe(403);
  });
  it('refuses redirects and bounded response overflow without leaking credentials or provider errors', async () => {
    for (const path of ['/redirect', '/secret-error', '/secret-echo', '/oversized']) {
      const result = await relay(path, { maxBytes: 100 })(request()); expect(result.status).toBe(502);
      const text = await result.text(); expect(text).not.toContain(upstreamToken); expect(text).not.toContain(clientToken);
    }
    expect((await relay('/slow', { timeoutMs: 10 })(request())).status).toBe(504);
  });
  it('rejects overlarge and slow caller bodies before any provider access', async () => {
    // #6643: observe this relay's dispatch synchronously. A previous aborted /slow
    // fetch can still arrive at the HTTP server after its caller has timed out.
    let dispatched = 0;
    const observedTransport: FetchTransport = (url, init) => { dispatched++; return transport(url, init); };
    expect((await relay('/json', { transport: observedTransport })(request({ providerId: 'demo', kind: 'json', query: 'x'.repeat(300001) }))).status).toBe(400);
    expect(dispatched).toBe(0);
    const slow = new ReadableStream<Uint8Array>({ start() { /* intentionally idle stream, bounded by the relay timeout */ } });
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' }, body: slow, duplex: 'half' };
    expect((await relay('/json', { timeoutMs: 10, transport: observedTransport })(new Request('https://relay.example.org', init))).status).toBe(408);
    expect(dispatched).toBe(0);
  });
  it('viewer/CLI shared provider speaks the relay wire format without persisting credentials', async () => {
    const handle = relay('/select');
    const relayTransport: FetchTransport = async (url, init) => handle(new Request(url, init));
    const result = await createSemanticProvider(relayTransport).read({ endpoint: 'https://relay.example.org', host: 'relay.example.org', kind: 'select',
      query: 'SELECT * WHERE {?s ?p ?o}', relayProvider: 'demo', bearer: clientToken });
    expect(result.kind).toBe('select'); expect(JSON.stringify(result)).not.toContain(clientToken); expect(JSON.stringify(result)).not.toContain(upstreamToken);
  });
});
