/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createAutodeskHandler } from '../src/handler.js';
import type { AutodeskServiceConfig } from '../src/config.js';
export const origin = 'https://viewer.example';
export function harness(options: Pick<AutodeskServiceConfig, 'now' | 'adapters' | 'maxConcurrentImports'> = {}) {
  const calls: { url: string; auth: string | null; form: URLSearchParams }[] = [];
  const handler = createAutodeskHandler({ ...options, origin, clientId: 'app', clientSecret: 'secret', fetch: async (input, init) => {
    const url = String(input); calls.push({ url, auth: new Headers(init?.headers).get('authorization'), form: new URLSearchParams(typeof init?.body === 'string' || init?.body instanceof URLSearchParams ? init.body : undefined) });
    if (url.endsWith('/token')) return Response.json({ access_token: 'PRIVATE_ACCESS_TOKEN', refresh_token: 'PRIVATE_REFRESH_TOKEN', expires_in: 3600 });
    if (url === 'https://api.userprofile.autodesk.com/userinfo') return Response.json({ sub: 'autodesk-user', name: 'Test user' });
    if (url.includes('signeds3download')) return Response.json({ url: 'https://bucket.s3.eu-west-1.amazonaws.com/file?sig=private' });
    if (url.includes('amazonaws.com')) return new Response('ISO-10303-21;');
    return Response.json({ data: [] });
  } });
  return { handler, calls };
}
export async function bootstrap(handler: ReturnType<typeof createAutodeskHandler>) {
  const response = await handler(new Request(`${origin}/api/autodesk/session`));
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const body = await response.json() as { csrf: string; identity: unknown };
  return { cookie, csrf: body.csrf };
}
export async function login(handler: ReturnType<typeof createAutodeskHandler>) {
  const session = await bootstrap(handler);
  const authorize = await handler(new Request(`${origin}/api/autodesk/authorize`, { method: 'POST', headers: { cookie: session.cookie, origin, 'x-ifclite-csrf': session.csrf } }));
  const transaction = await authorize.json() as { url: string; state: string };
  const callback = await handler(new Request(`${origin}/api/autodesk/callback?code=code&state=${transaction.state}`, { headers: { cookie: session.cookie } }));
  return { ...session, transaction, callback, cookie: callback.headers.get('set-cookie')!.split(';')[0] };
}
