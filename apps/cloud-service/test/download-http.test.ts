/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCloudHandler } from '../src/handler.js';
it('HTTP preparation and polling finish before upstream bytes arrive, with a session-owned single claim (#6840)', async () => {
  const origin = 'https://viewer.example'; const root = await mkdtemp(join(tmpdir(), 'ifclite-job-http-'));
  let release: ((response: Response) => void) | undefined;
  const app = createCloudHandler({ origin, downloadDirectory: root, apps: { dropbox: { clientId: 'app', clientSecret: 'fixture-secret' } }, fetch: async input => {
    const url = String(input);
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
    if (url.endsWith('/get_current_account')) return Response.json({ account_id: 'fixture-user' });
    return new Promise<Response>(resolve => { release = resolve; });
  } });
  let cookie = ''; let csrf = '';
  const request = (action: string, body?: unknown) => new Request(`${origin}/api/cloud/dropbox/${action}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: origin, 'x-ifclite-csrf': csrf, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const initial = await app.handle(request('session')); cookie = initial.headers.get('set-cookie')?.split(';')[0] ?? ''; csrf = (await initial.json()).csrf;
    const auth = await (await app.handle(request('authorize', {}))).json();
    const callback = await app.handle(request(`callback?code=fixture-code&state=${auth.state}`));
    expect(callback.status).toBe(303); cookie = callback.headers.get('set-cookie')?.split(';')[0] ?? '';
    csrf = (await (await app.handle(request('session'))).json()).csrf;
    const prepared = await app.handle(request('prepare-download', { path: 'rev:pinned' })); expect(prepared.status).toBe(202);
    const { jobId } = await prepared.json();
    const status = await app.handle(request('download-status', { jobId })); expect(await status.json()).toEqual({ state: 'preparing' });
    await vi.waitFor(() => expect(release).toBeDefined()); release?.(new Response('ISO-10303-21;'));
    await vi.waitFor(async () => expect(await (await app.handle(request('download-status', { jobId }))).json()).toEqual({ state: 'ready' }));
    const artifact = await app.handle(request('download', { jobId })); expect(artifact.status).toBe(200); expect(await artifact.text()).toBe('ISO-10303-21;');
    expect((await app.handle(request('download', { jobId }))).status).toBe(404); expect(await readdir(root)).toEqual([]);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
