/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { harness, bootstrap, login, origin } from './handler-fixture.js';
import { boundedResponse, apsUrl, signedUrl } from '../src/upstream.js';
describe('Autodesk session gateway', () => {
  it('keeps tokens server-side and rotates the opaque session after PKCE login', async () => {
    const h = harness(); const signed = await login(h.handler);
    expect(signed.callback.status).toBe(303);
    const response = await h.handler(new Request(`${origin}/api/autodesk/session`, { headers: { cookie: signed.cookie } }));
    const body = await response.text(); expect(body).toContain('autodesk-user'); expect(body).not.toContain('PRIVATE_');
    expect(signed.callback.headers.get('set-cookie')).toContain('HttpOnly'); expect(signed.callback.headers.get('set-cookie')).toContain('Secure');
    // #6827: the real OIDC profile lives outside the APS authentication path.
    expect(h.calls.find((call) => call.url === 'https://api.userprofile.autodesk.com/userinfo')?.auth).toBe('Bearer PRIVATE_ACCESS_TOKEN');
    const tokenCall = h.calls.find((call) => call.url.endsWith('/token'))!;
    expect(tokenCall.auth).toBe(`Basic ${Buffer.from('app:secret').toString('base64')}`);
    expect(tokenCall.form.has('client_id')).toBe(false);
    expect(tokenCall.form.get('grant_type')).toBe('authorization_code');
    expect(tokenCall.form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const replay = await h.handler(new Request(`${origin}/api/autodesk/callback?code=code&state=${signed.transaction.state}`, { headers: { cookie: signed.cookie } }));
    expect(replay.headers.get('location')).toContain('error=');
    expect(h.calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(1);
  });
  // #6827: confidential-client auth must normalize shared public-client refresh forms too.
  it('refreshes with Basic authentication without duplicate client credentials in the form', async () => {
    let now = Date.now();
    const h = harness({ now: () => now }); const signed = await login(h.handler);
    // Keep the session active while moving past the access token's lifetime.
    for (let step = 0; step < 4; step++) {
      now += 16 * 60_000;
      const response = await h.handler(new Request(`${origin}/api/autodesk/session`, { headers: { cookie: signed.cookie } }));
      expect(response.status).toBe(200);
      expect((await response.json() as { identity: { id: string } }).identity.id).toBe('autodesk-user');
    }
    const refresh = h.calls.find((call) => call.form.get('grant_type') === 'refresh_token')!;
    expect(refresh).toBeDefined();
    expect(refresh.auth).toBe(`Basic ${Buffer.from('app:secret').toString('base64')}`);
    expect(refresh.form.has('client_id')).toBe(false);
    expect(refresh.form.get('refresh_token')).toBe('PRIVATE_REFRESH_TOKEN');
  });
  it('rejects mutations from another origin or without CSRF proof', async () => {
    const h = harness(); const session = await bootstrap(h.handler);
    const cases: Record<string, string>[] = [{ cookie: session.cookie, origin: 'https://evil.example', 'x-ifclite-csrf': session.csrf }, { cookie: session.cookie, origin }];
    for (const headers of cases) {
      expect((await h.handler(new Request(`${origin}/api/autodesk/authorize`, { method: 'POST', headers }))).status).toBe(403);
    }
    expect(h.calls).toEqual([]);
  });
  it('rejects the callback after a cancelled server transaction', async () => {
    const h = harness(); const session = await bootstrap(h.handler);
    const headers = { cookie: session.cookie, origin, 'x-ifclite-csrf': session.csrf };
    const authorize = await h.handler(new Request(`${origin}/api/autodesk/authorize`, { method: 'POST', headers }));
    const transaction = await authorize.json() as { state: string };
    expect((await h.handler(new Request(`${origin}/api/autodesk/cancel-signin`, { method: 'POST', headers }))).status).toBe(200);
    const callback = await h.handler(new Request(`${origin}/api/autodesk/callback?code=code&state=${transaction.state}`, { headers }));
    expect(callback.headers.get('location')).toContain('error=expired-transaction');
    expect(h.calls).toEqual([]);
  });
  it('ends authenticated access and clears the cookie on sign-out', async () => {
    const h = harness(); const signed = await login(h.handler);
    const session = await h.handler(new Request(`${origin}/api/autodesk/session`, { headers: { cookie: signed.cookie } }));
    const value = await session.json() as { csrf: string };
    const signout = await h.handler(new Request(`${origin}/api/autodesk/signout`, { method: 'POST', headers: { cookie: signed.cookie, origin, 'x-ifclite-csrf': value.csrf } }));
    expect(signout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await h.handler(new Request(`${origin}/api/autodesk/request?path=/project/v1/hubs&region=US`, { headers: { cookie: signed.cookie } }))).status).toBe(401);
  });
  it('expires an idle session before another authenticated request', async () => {
    let now = Date.now();
    const h = harness({ now: () => now }); const signed = await login(h.handler);
    now += 30 * 60_000 + 1;
    expect((await h.handler(new Request(`${origin}/api/autodesk/request?path=/project/v1/hubs&region=US`, { headers: { cookie: signed.cookie } }))).status).toBe(401);
    const session = await h.handler(new Request(`${origin}/api/autodesk/session`, { headers: { cookie: signed.cookie } }));
    expect((await session.json() as { identity: unknown }).identity).toBeNull();
    expect(session.headers.get('set-cookie')!.split(';')[0]).not.toBe(signed.cookie);
  });
  it('bounds downloads without trusting Content-Length', async () => {
    const controller = new AbortController();
    const source = new Response(new ReadableStream<Uint8Array>({ start(output) { output.enqueue(new Uint8Array(4)); output.enqueue(new Uint8Array(4)); output.close(); } }));
    await expect(boundedResponse(source, 6, controller).arrayBuffer()).rejects.toThrow('download limit');
    expect(controller.signal.aborted).toBe(true);
  });
  it('never follows an arbitrary upstream URL with user credentials', () => {
    expect(() => apsUrl('https://evil.example/data/v1/projects/p/items/i')).toThrow();
    expect(() => apsUrl('/authentication/v2/token')).toThrow();
    expect(() => apsUrl('https://api.userprofile.autodesk.com/userinfo?other=1')).toThrow();
    expect(() => apsUrl('https://api.userprofile.autodesk.com.evil.example/userinfo')).toThrow();
    expect(() => apsUrl('/authentication/v2/userinfo')).toThrow();
    expect(() => apsUrl('/data/v1/projects/p/storage')).toThrow();
    expect(() => signedUrl('http://127.0.0.1/private')).toThrow();
    expect(() => signedUrl('https://bucket.s3.amazonaws.com.evil.example/private')).toThrow();
  });
  it('streams signed model bytes without forwarding the Autodesk bearer token', async () => {
    const h = harness(); const signed = await login(h.handler);
    const response = await h.handler(new Request(`${origin}/api/autodesk/storage?${new URLSearchParams({ id: 'urn:adsk.objects:os.object:bucket/file', region: 'EMEA' })}`, { headers: { cookie: signed.cookie } }));
    expect(await response.text()).toBe('ISO-10303-21;');
    expect(h.calls.find((call) => call.url.includes('amazonaws.com'))?.auth).toBeNull();
  });
  it('does not advertise or run missing native conversion adapters', async () => {
    const h = harness(); const signed = await login(h.handler);
    const response = await h.handler(new Request(`${origin}/api/autodesk/session`, { headers: { cookie: signed.cookie } }));
    const session = await response.json() as { csrf: string; imports: unknown[] };
    expect(session.imports).toEqual([]);
    const conversion = await h.handler(new Request(`${origin}/api/autodesk/import`, { method: 'POST', headers: { cookie: signed.cookie, origin, 'x-ifclite-csrf': session.csrf }, body: JSON.stringify({ kind: 'exchange', ref: {} }) }));
    expect(conversion.status).toBe(503);
  });
});
