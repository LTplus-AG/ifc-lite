/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { autodeskHttpServer } from '../src/http-server.js';
import { createExchangeWorkerHandler } from '../src/exchange-worker-handler.js';
import { remoteExchangeAdapter } from '../src/remote-exchange-adapter.js';
import type { NativeArtifactAdapter } from '../src/config.js';
const key = 'a'.repeat(43);
const origin = 'https://worker.example';
const ref = { projectId: 'project', containerId: 'folder', fileId: 'exchange', revisionId: 'revision/1' };
const ifc = new TextEncoder().encode('ISO-10303-21;\nHEADER;ENDSEC;DATA;ENDSEC;END-ISO-10303-21;');
const artifact = { revisionId: ref.revisionId, format: 'ifc' as const, bytes: ifc };
function fetchHandler(handler: (request: Request) => Promise<Response>): typeof fetch {
  return (input, init) => handler(new Request(input, init));
}
const input = () => ({ ref, region: 'EMEA' as const, accessToken: 'delegated-user-token', signal: new AbortController().signal });
const local: NativeArtifactAdapter = { kind: 'exchange', convert: async () => artifact };
const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
describe('Railway to Windows exchange job protocol', () => {
  it('runs the gateway protocol through the real Node HTTP adapter', async () => {
    const handler = createExchangeWorkerHandler(key, local);
    const server = autodeskHttpServer(origin, handler).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server port.');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const forward: typeof fetch = (request, init) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      expect(url.origin).toBe(origin);
      return fetch(`${endpoint}${url.pathname}`, init);
    };
    try {
      expect((await fetch(`${endpoint}/healthz`)).status).toBe(401);
      const result = await remoteExchangeAdapter(origin, key, forward).convert(input());
      expect(result.bytes).toEqual(ifc); expect(result.revisionId).toBe(ref.revisionId);
      const rejected = await fetch(`${endpoint}/api/exchange-worker/imports`, { method: 'POST', headers: auth, body: 'x'.repeat(64_001) });
      expect(rejected.status).toBe(413);
    } finally {
      await handler.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it('uses server authentication and delegated identity, then retrieves the pinned IFC once', async () => {
    let delegated: string | undefined;
    const handler = createExchangeWorkerHandler(key, { kind: 'exchange', convert: async (value) => {
      delegated = value.accessToken;
      expect(value.ref).toEqual(ref); expect(value.region).toBe('EMEA'); return artifact;
    } });
    const remote = remoteExchangeAdapter(origin, key, fetchHandler(handler));
    const result = await remote.convert(input());
    expect(delegated).toBe('delegated-user-token'); expect(result).toEqual(artifact);
    const unauthorized = await handler(new Request(`${origin}/healthz`));
    expect(unauthorized.status).toBe(401);
    const wrong = await handler(new Request(`${origin}/api/exchange-worker/imports`, { method: 'POST', headers: { Authorization: `Bearer ${'b'.repeat(43)}` }, body: JSON.stringify(input()) }));
    expect(wrong.status).toBe(401);
  });
  it('aborts the SDK job when its initiating gateway import is cancelled', async () => {
    let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
    let cancelled!: () => void; const aborted = new Promise<void>(resolve => { cancelled = resolve; });
    const handler = createExchangeWorkerHandler(key, { kind: 'exchange', convert: ({ signal }) => {
      started(); return new Promise((_, reject) => { signal.addEventListener('abort', () => { cancelled(); reject(signal.reason); }, { once: true }); });
    } });
    const remote = remoteExchangeAdapter(origin, key, fetchHandler(handler));
    const controller = new AbortController();
    const pending = remote.convert({ ...input(), signal: controller.signal });
    const rejection = expect(pending).rejects.toBeDefined();
    await began; controller.abort(); await rejection; await aborted;
  });
  it('refuses changed revisions, invalid IFC and excessive streamed bytes', async () => {
    const changed = createExchangeWorkerHandler(key, { kind: 'exchange', convert: async () => ({ ...artifact, revisionId: 'different' }) });
    await expect(remoteExchangeAdapter(origin, key, fetchHandler(changed)).convert(input())).rejects.toMatchObject({ code: 'exchange-worker-failed' });
    const invalid = createExchangeWorkerHandler(key, { kind: 'exchange', convert: async () => ({ ...artifact, bytes: new Uint8Array([1]) }) });
    await expect(remoteExchangeAdapter(origin, key, fetchHandler(invalid)).convert(input())).rejects.toMatchObject({ code: 'invalid-ifc' });
    await expect(remoteExchangeAdapter(origin, key, fetchHandler(createExchangeWorkerHandler(key, local)), 8).convert(input())).rejects.toMatchObject({ code: 'artifact-limit' });
  });
  it('requires HTTPS and a strong configured key, never follows a worker redirect', async () => {
    expect(() => remoteExchangeAdapter('http://worker.example', key)).toThrow(/HTTPS/);
    expect(() => remoteExchangeAdapter('https://worker.example/path', key)).toThrow(/HTTPS/);
    expect(() => remoteExchangeAdapter(origin, 'short')).toThrow(/32 bytes/);
    const redirecting: typeof fetch = async (_input, init) => {
      expect(init?.redirect).toBe('error');
      return new Response(null, { status: 307, headers: { Location: 'https://attacker.example' } });
    };
    await expect(remoteExchangeAdapter(origin, key, redirecting).convert(input())).rejects.toMatchObject({ code: 'exchange-worker-failed' });
  });
  it('bounds unclaimed jobs and allows one claim per artifact', async () => {
    const handler = createExchangeWorkerHandler(key, local);
    const start = () => handler(new Request(`${origin}/api/exchange-worker/imports`, { method: 'POST', headers: auth, body: JSON.stringify(input()) }));
    const a = await start(); const { id } = await a.json() as { id: string }; await start();
    expect((await start()).status).toBe(429);
    const get = () => handler(new Request(`${origin}/api/exchange-worker/imports/${id}/artifact`, { headers: auth }));
    const download = await get(); expect(download.status).toBe(200); expect((await get()).status).toBe(404);
    expect((await start()).status).toBe(429);
    await download.arrayBuffer(); expect((await start()).status).toBe(202);
  });
  it('drains worker shutdown by cancelling active exports and refusing new jobs', async () => {
    let abort!: () => void; const stopped = new Promise<void>(resolve => { abort = resolve; });
    const handler = createExchangeWorkerHandler(key, { kind: 'exchange', convert: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { abort(); reject(signal.reason); }, { once: true });
    }) });
    const start = () => handler(new Request(`${origin}/api/exchange-worker/imports`, { method: 'POST', headers: auth, body: JSON.stringify(input()) }));
    const initial = await start(); expect(initial.status).toBe(202);
    const { id } = await initial.json() as { id: string };
    const closing = handler.close(); await stopped; await closing;
    expect((await handler(new Request(`${origin}/api/exchange-worker/imports/${id}`, { headers: auth }))).status).toBe(404);
    expect((await start()).status).toBe(503);
  });
  it('rejects malformed and oversized authenticated input before invoking an exporter', async () => {
    let invoked = false;
    const handler = createExchangeWorkerHandler(key, { kind: 'exchange', convert: async () => { invoked = true; return artifact; } });
    const send = (body: string) => handler(new Request(`${origin}/api/exchange-worker/imports`, { method: 'POST', headers: auth, body }));
    expect((await send('{')).status).toBe(400);
    expect((await send(JSON.stringify({ ...input(), region: 'invalid' }))).status).toBe(400);
    expect((await send('x'.repeat(64_001))).status).toBe(413);
    expect(invoked).toBe(false);
  });

  it('bounds worker JSON responses before decoding them', async () => {
    const oversized: typeof fetch = async () => new Response(JSON.stringify({ id: 'x'.repeat(70_000) }), { status: 202 });
    await expect(remoteExchangeAdapter(origin, key, oversized).convert(input())).rejects.toMatchObject({ code: 'artifact-limit' });
  });

  it('keeps cancelled native work in the capacity budget until its process settles', async () => {
    let finish!: (value: typeof artifact) => void; let first = true;
    const handler = createExchangeWorkerHandler(key, { kind: 'exchange', convert: ({ signal }) => {
      if (first) { first = false; return new Promise(resolve => { finish = resolve; }); }
      return new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    } });
    const start = () => handler(new Request(`${origin}/api/exchange-worker/imports`, { method: 'POST', headers: auth, body: JSON.stringify(input()) }));
    const { id } = await (await start()).json() as { id: string };
    await start();
    const cancelled = await handler(new Request(`${origin}/api/exchange-worker/imports/${id}/cancel`, { method: 'POST', headers: auth, body: '{}' }));
    expect(cancelled.status).toBe(200);
    expect((await start()).status).toBe(429);
    finish(artifact); await new Promise(resolve => setImmediate(resolve));
    expect((await start()).status).toBe(202);
    await handler.close();
  });

});
