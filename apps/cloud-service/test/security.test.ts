/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { createCloudHandler } from '../src/handler.js';
import { CloudSessions } from '../src/sessions.js';
import { graphUrl, approvedDownload, requestJson, downloadBytes } from '../src/upstream.js';
import { readBytes, stripDownloadUrls } from '../src/bounded.js';
import { validateConfig, validTenant, type CloudConfig } from '../src/config.js';
const origin = 'https://viewer.example';
const config: CloudConfig = { origin, apps: { dropbox: { clientId: 'dropbox-app', clientSecret: 'private-secret' }, msgraph: { clientId: 'microsoft-app', clientSecret: 'private-secret' } } };
describe('hosted cloud security invariants (#6840)', () => {
  it('rejects foreign request origins and cross-site metadata while allowing the vendor callback', async () => {
    const app = createCloudHandler(config);
    expect((await app.handle(new Request('https://other.example/api/cloud/dropbox/session'))).status).toBe(404);
    expect((await app.handle(new Request(`${origin}/api/cloud/dropbox/session`, { headers: { 'sec-fetch-site': 'cross-site' } }))).status).toBe(403);
    const callback = await app.handle(new Request(`${origin}/api/cloud/dropbox/callback?state=invalid`, { headers: { 'sec-fetch-site': 'cross-site' } }));
    expect(callback.status).toBe(303); expect(new URL(callback.headers.get('location') ?? '').origin).toBe(origin); app.close();
  });
  it('accepts only reserved tenants, GUIDs or well-formed domains', () => {
    for (const tenant of ['common', 'organizations', 'consumers', '12345678-1234-1234-1234-123456789abc', 'company.onmicrosoft.com']) expect(validTenant(tenant)).toBe(true);
    for (const tenant of ['', '..', '.example.com', 'example.com.', '-company.com', 'company-.com', 'company..com', 'company.com/evil', 'company.com?x=y', '127.0.0.1', 'singlelabel']) expect(validTenant(tenant)).toBe(false);
  });
  it('keeps unconfigured sources explicit and vendor sessions isolated', async () => {
    const app = createCloudHandler({ origin, apps: {} });
    const response = await app.handle(new Request(`${origin}/api/cloud/dropbox/session`));
    const data = await response.json() as { configured: boolean; identity: unknown; csrf: string };
    expect(data.configured).toBe(false); expect(data.identity).toBeNull(); expect(data.csrf.length).toBeGreaterThan(32);
    expect(response.headers.get('set-cookie')).toContain('__Host-ifclite-cloud-dropbox=');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax; Secure;');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const foreign = await app.handle(new Request(`${origin}/api/cloud/msgraph/authorize`, { method: 'POST', headers: { cookie: response.headers.get('set-cookie') ?? '', Origin: origin, 'x-ifclite-csrf': data.csrf } }));
    expect(foreign.status).toBe(403); app.close();
  });
  it('rejects missing Origin or CSRF before authorization and scopes Dropbox to interactive access', async () => {
    const app = createCloudHandler(config);
    const session = await app.handle(new Request(`${origin}/api/cloud/dropbox/session`));
    const data = await session.json() as { csrf: string }; const cookie = session.headers.get('set-cookie') ?? '';
    const denied = await app.handle(new Request(`${origin}/api/cloud/dropbox/authorize`, { method: 'POST', headers: { cookie, 'x-ifclite-csrf': data.csrf } })); expect(denied.status).toBe(403);
    const response = await app.handle(new Request(`${origin}/api/cloud/dropbox/authorize`, { method: 'POST', headers: { cookie, Origin: origin, 'x-ifclite-csrf': data.csrf } }));
    const auth = await response.json() as { url: string; state: string }; const url = new URL(auth.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(url.searchParams.get('token_access_type')).toBeNull();
    expect(url.searchParams.get('redirect_uri')).toBe(`${origin}/api/cloud/dropbox/callback`); expect(auth.url).not.toContain('private-secret'); app.close();
  });
  it('bounds sessions and makes cancellation invalidate an outstanding callback', async () => {
    const sessions = new CloudSessions({ ...config, maxSessions: 1 }); const session = sessions.create('dropbox');
    expect(() => sessions.create('msgraph')).toThrow('capacity');
    const auth = await sessions.authorize(session); sessions.cancel(session);
    await expect(sessions.callback(new Request(`${origin}/api/cloud/dropbox/callback?code=x&state=${auth.state}`), session)).rejects.toThrow('expired'); sessions.close();
  });
  it('rejects mismatched state once, without contacting token endpoints', async () => {
    let calls = 0; const sessions = new CloudSessions({ ...config, fetch: async () => { calls++; throw new Error('Unexpected request'); } });
    const session = sessions.create('dropbox'); await sessions.authorize(session);
    await expect(sessions.callback(new Request(`${origin}/api/cloud/dropbox/callback?code=x&state=wrong`), session)).rejects.toThrow();
    expect(calls).toBe(0); expect(session.transaction).toBeUndefined(); sessions.close();
  });
  it('allows only own-drive Graph endpoints and prevents cursor-host and encoded-path escapes', () => {
    expect(graphUrl('/me/drive/root/children').hostname).toBe('graph.microsoft.com');
    expect(graphUrl('https://graph.microsoft.com/v1.0/me/drive/root/delta?$deltatoken=abc').pathname).toContain('/me/drive/root/delta');
    for (const path of ['https://evil.example/v1.0/me/drive', '/sites', '/users/alice/drive', '/me/drive/items/a%2fb', '/me/drive/items/../../users', '/me/drive?$expand=permissions']) expect(() => graphUrl(path)).toThrow();
    expect(approvedDownload(new URL('https://tenant.sharepoint.com/file'))).toBe(true);
    for (const host of ['https://sharepoint.com.evil.example/file', 'http://tenant.sharepoint.com/file', 'https://tenant.sharepoint.com:8443/file', 'https://127.0.0.1/file']) expect(approvedDownload(new URL(host))).toBe(false);
  });
  it('removes preauthenticated download links deeply and bounds unknown-length bodies', async () => {
    const value = { value: [{ '@microsoft.graph.downloadUrl': 'secret-link', nested: { '@microsoft.graph.downloadUrl': 'secret-link', name: 'model' } }] };
    expect(JSON.stringify(stripDownloadUrls(value))).not.toContain('secret-link');
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); controller.close(); } }));
    await expect(readBytes(response, 10)).rejects.toThrow('size limit');
  });
  it('does not proxy Dropbox writes or arbitrary download URLs', async () => {
    const sessions = new CloudSessions(config); const session = sessions.create('dropbox');
    await expect(requestJson(sessions, session, { path: '/files/delete_v2' }, AbortSignal.timeout(1000))).rejects.toThrow('Unsupported');
    await expect(downloadBytes(sessions, session, { path: 'https://evil.example/file' }, AbortSignal.timeout(1000))).rejects.toThrow('reference'); sessions.close();
  });
  it('requires HTTPS and rejects partial credentials', () => {
    expect(() => validateConfig({ origin: 'http://viewer.example', apps: {} })).toThrow('HTTPS');
    expect(() => validateConfig({ origin, apps: { dropbox: { clientId: 'id', clientSecret: '' } } })).toThrow('both');
  });
  it('aborts owned work on signout and keeps operation capacity until settlement', () => {
    const sessions = new CloudSessions({ ...config, maxOperations: 1 }); const session = sessions.create('dropbox'); const operation = sessions.operation(session);
    expect(() => sessions.operation(session)).toThrow('busy'); sessions.discard(session); expect(operation.signal.aborted).toBe(true);
    const other = sessions.create('msgraph'); expect(() => sessions.operation(other)).toThrow('busy');
    operation.done(); const next = sessions.operation(other); next.done(); sessions.close();
  });
});
