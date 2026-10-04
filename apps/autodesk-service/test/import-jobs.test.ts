/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { harness, login, origin } from './handler-fixture.js';
import type { NativeArtifactAdapter } from '../src/config.js';

const ref = { projectId: 'project', containerId: 'folder', fileId: 'file', revisionId: 'version' };
type Auth = Awaited<ReturnType<typeof login>>;
function request(path: string, auth: Auth, method: 'GET' | 'POST' = 'GET', body?: unknown): Request {
  const headers = { cookie: auth.cookie, origin, 'x-ifclite-csrf': auth.csrf };
  const url = `${origin}/api/autodesk/${path}`;
  if (method === 'GET') return new Request(url, { headers });
  return new Request(url, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined });
}
async function sessionCsrf(handler: ReturnType<typeof harness>['handler'], auth: Auth): Promise<Auth> {
  const response = await handler(request('session', auth));
  return { ...auth, csrf: ((await response.json()) as { csrf: string }).csrf };
}
function deferred() {
  let complete!: (value: Awaited<ReturnType<NativeArtifactAdapter['convert']>>) => void;
  let aborted!: () => void;
  const abort = new Promise<void>((resolve) => { aborted = resolve; });
  const result = new Promise<Awaited<ReturnType<NativeArtifactAdapter['convert']>>>((resolve) => { complete = resolve; });
  const adapter: NativeArtifactAdapter = { kind: 'proposal', convert: async ({ signal }) => {
    signal.addEventListener('abort', aborted, { once: true });
    return result;
  } };
  return { adapter, complete, abort };
}
describe('session-owned asynchronous native imports', () => {
  it('returns 202 before conversion, hides another session, pins artifact and consumes it once', async () => {
    const d = deferred(); const h = harness({ adapters: [d.adapter], maxConcurrentImports: 1 });
    const a = await sessionCsrf(h.handler, await login(h.handler));
    const b = await sessionCsrf(h.handler, await login(h.handler));
    const accepted = await h.handler(request('import', a, 'POST', { kind: 'proposal', ref, region: 'EMEA' }));
    expect(accepted.status).toBe(202);
    const { id } = await accepted.json() as { id: string };
    expect((await h.handler(request(`imports/${id}`, a))).status).toBe(200);
    expect((await h.handler(request(`imports/${id}`, b))).status).toBe(404);
    expect((await h.handler(request(`imports/${id}/artifact`, a))).status).toBe(409);
    d.complete({ revisionId: 'version', format: 'ifcx', bytes: new TextEncoder().encode('{"fixture":true}') });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await (await h.handler(request(`imports/${id}`, a))).json()).toEqual({ state: 'ready' });
    const artifact = await h.handler(request(`imports/${id}/artifact`, a));
    expect(artifact.headers.get('x-ifclite-revision')).toBe('version');
    expect(artifact.headers.get('x-ifclite-format')).toBe('ifcx');
    const busy = await h.handler(request('import', a, 'POST', { kind: 'proposal', ref, region: 'EMEA' }));
    expect(busy.status).toBe(429);
    await artifact.arrayBuffer();
    expect((await h.handler(request(`imports/${id}/artifact`, a))).status).toBe(404);
  });
  it('bounds preparing jobs and retained artifacts until cancelled work settles', async () => {
    const d = deferred(); const h = harness({ adapters: [d.adapter], maxConcurrentImports: 1 });
    const a = await sessionCsrf(h.handler, await login(h.handler));
    const start = () => h.handler(request('import', a, 'POST', { kind: 'proposal', ref, region: 'US' }));
    const { id } = await (await start()).json() as { id: string };
    expect((await start()).status).toBe(429);
    const cancelled = await h.handler(request(`imports/${id}/cancel`, a, 'POST'));
    expect(cancelled.status).toBe(200); await d.abort;
    expect((await h.handler(request(`imports/${id}`, a))).status).toBe(404);
    expect((await start()).status).toBe(429);
    d.complete({ revisionId: 'version', format: 'ifcx', bytes: new Uint8Array([1]) });
    await new Promise(resolve => setImmediate(resolve));
    const second = await start(); expect(second.status).toBe(202);
    const next = (await second.json() as { id: string }).id;
    d.complete({ revisionId: 'version', format: 'ifcx', bytes: new Uint8Array([1]) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await start()).status).toBe(429);
    await h.handler(request(`imports/${next}/cancel`, a, 'POST'));
  });
  it('sign-out aborts conversion and mismatched revisions cannot become downloadable artifacts', async () => {
    const d = deferred(); const h = harness({ adapters: [d.adapter] });
    const a = await sessionCsrf(h.handler, await login(h.handler));
    const first = await h.handler(request('import', a, 'POST', { kind: 'proposal', ref, region: 'US' }));
    const { id } = await first.json() as { id: string };
    d.complete({ revisionId: 'different', format: 'ifcx', bytes: new Uint8Array([1]) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = await h.handler(request(`imports/${id}`, a));
    expect(failed.status).toBe(502);
    expect((await failed.json() as { code: string }).code).toBe('revision-mismatch');
    const waiting = deferred(); const other = harness({ adapters: [waiting.adapter] });
    const user = await sessionCsrf(other.handler, await login(other.handler));
    await other.handler(request('import', user, 'POST', { kind: 'proposal', ref, region: 'US' }));
    expect((await other.handler(request('signout', user, 'POST'))).status).toBe(200);
    await waiting.abort;
  });
  it('health checks do not allocate sessions or call Autodesk', async () => {
    const h = harness();
    const health = await h.handler(new Request('https://healthcheck.railway.app/healthz'));
    expect(health.status).toBe(200); expect(health.headers.has('set-cookie')).toBe(false);
    expect(h.calls).toHaveLength(0);
  });
});
