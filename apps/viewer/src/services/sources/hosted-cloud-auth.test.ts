import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HostedCloudAuth, validateHostedAuthorization, validateHostedCallback } from './hosted-cloud-auth';
import { HostedCloudClient } from './hosted-cloud-client';
import type { PluginContext } from '@ifc-lite/plugin-api';
const ctx = {} as PluginContext;
function browser(open: () => Window | null) {
  const values = new Map<string, string>(); let destination = '';
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { open,
    location: { origin: 'https://viewer.test', pathname: '/viewer', search: '?model=x', hash: '#cloud', assign: (url: string) => { destination = url; } } } });
  return { values, destination: () => destination };
}
describe('hosted cloud authentication (#6840)', () => {
  it('rejects callback origin, route, state, errors and missing completion marker', () => {
    const valid = 'https://viewer.test/oauth/dropbox/callback?state=abc&connected=1';
    validateHostedCallback(valid, 'dropbox', 'https://viewer.test', 'abc');
    for (const url of [valid.replace('viewer.test', 'evil.test'), valid.replace('/dropbox/', '/msgraph/'), valid.replace('abc', 'other'), valid.replace('connected=1', 'error=access_denied'), valid + '&error=denied']) {
      assert.throws(() => validateHostedCallback(url, 'dropbox', 'https://viewer.test', 'abc'));
    }
    assert.throws(() => validateHostedAuthorization('https://evil.test/oauth2/authorize', 'dropbox'));
    assert.throws(() => validateHostedAuthorization('https://login.microsoftonline.com/common/arbitrary', 'msgraph'));
  });
  it('opens the popup before fetching and keeps popup-blocked fallback free of tokens', async () => {
    let opened = false; const env = browser(() => { opened = true; return null; });
    const fetcher: typeof fetch = async (input) => {
      assert.equal(opened, true);
      return String(input).endsWith('/authorize') ? Response.json({ state: 'abc', url: 'https://www.dropbox.com/oauth2/authorize?state=abc' })
        : Response.json({ csrf: 'csrf', configured: true, identity: null });
    };
    await assert.rejects(new HostedCloudAuth(new HostedCloudClient('dropbox', fetcher)).signIn(ctx), /Continue cloud sign-in/);
    const pending = JSON.parse(env.values.get('ifc-lite:cloud:dropbox:authorization')!);
    assert.deepEqual(Object.keys(pending).sort(), ['expiresAt', 'returnPath', 'state']);
    assert.equal(pending.returnPath, '/viewer?model=x#cloud'); assert.match(env.destination(), /^https:\/\/www.dropbox.com/);
  });
  it('restores a full-tab callback only after validating its pending transaction', async () => {
    const env = browser(() => null);
    env.values.set('ifc-lite:cloud:msgraph:authorization', JSON.stringify({ state: 'abc', expiresAt: Date.now() + 10000 }));
    env.values.set('ifc-lite:cloud:msgraph:callback', 'https://viewer.test/oauth/msgraph/callback?state=abc&connected=1');
    const client = new HostedCloudClient('msgraph', async () => Response.json({ csrf: 'csrf', configured: true, identity: { id: 'signed-in' } }));
    assert.equal((await new HostedCloudAuth(client).restore(ctx))?.id, 'signed-in'); assert.equal(env.values.size, 0);
  });
  it('cancellation during session discovery prevents a later authorize request or navigation', async () => {
    const env = browser(() => null); let release!: (response: Response) => void; let authorizations = 0;
    const fetcher: typeof fetch = async input => {
      if (String(input).endsWith('/authorize')) authorizations++;
      if (String(input).endsWith('/session') && !release) return new Promise<Response>(resolve => { release = resolve; });
      return Response.json({ csrf: 'csrf', configured: true, identity: null });
    };
    const auth = new HostedCloudAuth(new HostedCloudClient('dropbox', fetcher)); const waiting = auth.signIn(ctx);
    await new Promise(resolve => setImmediate(resolve)); auth.cancelSignIn();
    release(Response.json({ csrf: 'csrf', configured: true, identity: null }));
    await assert.rejects(waiting, { name: 'AbortError' }); assert.equal(authorizations, 0); assert.equal(env.destination(), '');
  });
  it('keeps the server identity available when sign-out fails', async () => {
    browser(() => null);
    const fetcher: typeof fetch = async input => String(input).endsWith('/signout')
      ? Response.json({ error: 'request-failed' }, { status: 502 })
      : Response.json({ csrf: 'csrf', configured: true, identity: { id: 'still-connected' } });
    const auth = new HostedCloudAuth(new HostedCloudClient('msgraph', fetcher));
    await assert.rejects(auth.signOut(ctx));
    assert.equal((await auth.getIdentity(ctx))?.id, 'still-connected');
  });
  it('completes a popup through the origin-scoped callback channel', async () => {
    let signedIn = false;
    const popup = { close() {}, location: { set href(_url: string) {
      setTimeout(() => {
        signedIn = true;
        const channel = new BroadcastChannel('ifc-lite:oauth-callback');
        channel.postMessage({ type: 'ifc-lite:oauth-callback', state: 'abc', url: 'https://viewer.test/oauth/dropbox/callback?state=abc&connected=1' });
        channel.close();
      }, 0);
    } } } as unknown as Window;
    browser(() => popup);
    const fetcher: typeof fetch = async input => String(input).endsWith('/authorize')
      ? Response.json({ state: 'abc', url: 'https://www.dropbox.com/oauth2/authorize?state=abc' })
      : Response.json({ csrf: 'csrf', configured: true, identity: signedIn ? { id: 'account' } : null });
    const identity = await new HostedCloudAuth(new HostedCloudClient('dropbox', fetcher)).signIn(ctx);
    assert.equal(identity.id, 'account');
  });

});
