/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { CloudSessions } from '../src/sessions.js';
const origin = 'https://viewer.example';
const apps = { msgraph: { clientId: 'registered-app', clientSecret: 'server-secret' } };
it('uses confidential Web PKCE exchange, rotates session and prevents callback replay (#6840)', async () => {
  let exchange: URLSearchParams | undefined;
  const sessions = new CloudSessions({ origin, apps, fetch: async (input, init) => {
    if (String(input).includes('/token')) {
      exchange = new URLSearchParams(String(init?.body));
      return Response.json({ access_token: 'server-access', refresh_token: 'server-refresh', expires_in: 3600 });
    }
    return Response.json({ id: 'user', displayName: 'User' });
  } });
  const session = sessions.create('msgraph'); const auth = await sessions.authorize(session);
  const authorization = new URL(auth.url);
  expect(authorization.searchParams.get('scope')).toBe('User.Read Files.Read offline_access');
  const callback = new Request(`${origin}/api/cloud/msgraph/callback?state=${auth.state}&code=vendor-code`);
  const connected = await sessions.callback(callback, session);
  expect(connected.id).not.toBe(session.id); expect(connected.csrf).not.toBe(session.csrf);
  expect(exchange?.get('client_secret')).toBe('server-secret'); expect(exchange?.get('code_verifier')).toBeTruthy();
  expect(exchange?.get('redirect_uri')).toBe(`${origin}/api/cloud/msgraph/callback`);
  expect(session.active).toBe(false); expect(sessions.cookie('msgraph', connected)).not.toContain('server-access');
  await expect(sessions.callback(callback, connected)).rejects.toThrow('expired'); sessions.close();
});
it('serializes Microsoft refresh and never resurrects a disconnected session (#6840)', async () => {
  let refreshCalls = 0; let finish: ((response: Response) => void) | undefined;
  const sessions = new CloudSessions({ origin, apps, fetch: async () => {
    refreshCalls++; return new Promise<Response>(resolve => { finish = resolve; });
  } });
  const session = sessions.create('msgraph'); session.token = { access: 'expired', refresh: 'refresh', expires: 0 };
  const first = sessions.access(session); const second = sessions.access(session);
  // Both access calls start synchronously, before the token endpoint resolves.
  expect(refreshCalls).toBe(1); sessions.discard(session);
  finish?.(Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }));
  const results = await Promise.allSettled([first, second]);
  expect(results.every(result => result.status === 'rejected')).toBe(true); expect(session.token).toBeUndefined(); sessions.close();
});
it('treats token revocation as signed out rather than retaining a usable session (#6840)', async () => {
  const sessions = new CloudSessions({ origin, apps, fetch: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }) });
  const session = sessions.create('msgraph'); session.token = { access: 'expired', refresh: 'revoked', expires: 0 };
  await expect(sessions.access(session)).rejects.toThrow('expired'); expect(session.active).toBe(false); sessions.close();
});
