/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HostedCloudClient, HostedCloudError } from './hosted-cloud-client';
import { hostedDropbox, hostedMsGraph } from './hosted-cloud-providers';
import type { PluginContext } from '@ifc-lite/plugin-api';
const ctx = { fetch: () => { throw new Error('Vendor-scoped fetch must not run'); }, getPreference: () => { throw new Error('Preferences must not run'); } } as unknown as PluginContext;
function gateway(vendor: 'dropbox' | 'msgraph', handler: (path: string, body: Record<string, unknown>) => Response) {
  const calls: { path: string; body: Record<string, unknown>; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    assert.ok(path.startsWith(`/api/cloud/${vendor}/`));
    assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store');
    if (path.endsWith('/session')) return Response.json({ csrf: 'csrf-test', configured: true, identity: { id: 'user' } });
    assert.equal(new Headers(init?.headers).get('x-ifclite-csrf'), 'csrf-test');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body, init }); return handler(path, body);
  };
  return { client: new HostedCloudClient(vendor, fetcher), calls };
}
describe('hosted cloud transport (#6840)', () => {
  it('proxies Dropbox revision downloads with byte progress and cancellation, without vendor credentials', async () => {
    const jobId = 'a'.repeat(43);
    const { client, calls } = gateway('dropbox', path => path.endsWith('/prepare-download')
      ? Response.json({ jobId }, { status: 202 }) : path.endsWith('/download-status')
      ? Response.json({ state: 'ready' }) : new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Length': '3' } }));
    const progress: number[] = []; const signal = new AbortController().signal;
    const bytes = await client.download({ path: 'rev:revision-123' }, { signal, onProgress: n => progress.push(n) });
    assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3]); assert.equal(progress.at(-1), 3);
    assert.equal(calls[0].body.path, 'rev:revision-123'); assert.equal(calls[0].init?.signal?.aborted, false);
    assert.deepEqual(calls.map(call => call.path.split('/').at(-1)), ['prepare-download', 'download-status', 'download']);
    assert.deepEqual(calls[2].body, { jobId });
  });
  it('cancels a preparing job when the caller aborts, preserving its reason (#6840)', async () => {
    const controller = new AbortController(); const reason = new Error('user cancelled'); const jobId = 'b'.repeat(43);
    const { client, calls } = gateway('msgraph', path => {
      if (path.endsWith('/prepare-download')) return Response.json({ jobId }, { status: 202 });
      if (path.endsWith('/download-status')) { controller.abort(reason); return Response.json({ state: 'preparing' }); }
      return Response.json({ ok: true });
    });
    await assert.rejects(client.download({ path: '/me/drive/items/file/content', revision: 'v1' }, { signal: controller.signal }), error => error === reason);
    assert.equal(calls.at(-1)?.path, '/api/cloud/msgraph/cancel-download');
    assert.deepEqual(calls.at(-1)?.body, { jobId });
    assert.equal(calls.at(-1)?.init?.signal?.aborted, false);
  });
  it('bounds a stalled status request and cancels the job at the deadline (#6840)', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const jobId = 'd'.repeat(43); let polling: (() => void) | undefined;
    const started = new Promise<void>(resolve => { polling = resolve; }); let cancelled = false;
    const fetcher: typeof fetch = async (input, init) => {
      const path = String(input);
      if (path.endsWith('/session')) return Response.json({ identity: { id: 'user' }, csrf: 'fixture', configured: true });
      if (path.endsWith('/prepare-download')) return Response.json({ jobId }, { status: 202 });
      if (path.endsWith('/cancel-download')) { cancelled = true; return Response.json({ ok: true }); }
      polling?.();
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
    };
    const downloading = new HostedCloudClient('dropbox', fetcher).download({ path: 'rev:fixture' });
    const rejected = assert.rejects(downloading, (error: unknown) => error instanceof HostedCloudError && error.code === 'download-timeout');
    await started; t.mock.timers.tick(15 * 60_000); await rejected; assert.equal(cancelled, true);
  });
  it('reports preparation and byte-transfer phases without cancelling a consumed artifact (#6840)', async () => {
    const phases: string[] = []; const jobId = 'c'.repeat(43);
    const { client, calls } = gateway('msgraph', path => path.endsWith('/prepare-download') ? Response.json({ jobId }, { status: 202 })
      : path.endsWith('/download-status') ? Response.json({ state: 'ready' }) : new Response('ISO-10303-21;'));
    await client.download({ path: '/me/drive/items/file/content', revision: 'v1' }, { onPhase: phase => phases.push(phase) });
    assert.deepEqual(phases, ['preparing', 'downloading']);
    assert.equal(calls.some(call => call.path.endsWith('/cancel-download')), false);
  });
  it('creates hosted providers that restore account identity without preferences or scoped fetch', async () => {
    for (const vendor of ['dropbox', 'msgraph'] as const) {
      const { client } = gateway(vendor, () => Response.json({}));
      const provider = vendor === 'dropbox' ? hostedDropbox(client) : hostedMsGraph(client);
      assert.deepEqual(await provider.auth?.getIdentity(ctx), { id: 'user', displayName: undefined, email: undefined, organization: undefined });
    }
  });
  it('does not render upstream HTML, URLs or credentials in gateway failures', async () => {
    const { client } = gateway('msgraph', () => Response.json({ error: 'denied', message: '<html>https://secret/token=unsafe</html>' }, { status: 502 }));
    await assert.rejects(client.request({ path: '/me/drive/root/children' }), (error: unknown) => {
      assert.ok(error instanceof HostedCloudError); assert.equal(error.status, 502); assert.ok(!error.message.includes('unsafe')); return true;
    });
  });
  it('does not send an operation after a session fetch is cancelled', async () => {
    const controller = new AbortController(); let requests = 0;
    const fetcher: typeof fetch = async () => { requests++; controller.abort(); return Response.json({ identity: null, csrf: 'test', configured: true }); };
    await assert.rejects(new HostedCloudClient('dropbox', fetcher).request({ path: '/files/list_folder' }, controller.signal));
    assert.equal(requests, 1);
  });
});
