/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import { OciClient, parseReference } from '../src/index.js';
import { basic, closeAll, query, startServer, tokenRealm, type FakeServer } from './fake-registry.js';
import { ociFailure, pushRegistry } from './push-registry.js';

afterEach(closeAll);

const insecure = ['127.0.0.1'];
const PAYLOAD = new TextEncoder().encode('blob pushed under a token');
const PUSH_SCOPE = 'repository:team/model:pull,push';
const PULL_SCOPE = 'repository:team/model:pull';

function ref(server: FakeServer) {
  return parseReference(`${server.host}/team/model:v1`, { insecureHosts: insecure });
}

function challenge(realm: string): string {
  // The placeholder scope registries send; the client must ignore it.
  return `Bearer realm="${realm}",service="fake-registry",scope="repository:user/image:pull"`;
}

/** A realm that issues `tok:<requested scope>`. */
function scopedTokenRealm() {
  return tokenRealm((req) => ({ token: `tok:${new URL(req.url ?? '', 'http://x').searchParams.get('scope')}` }));
}

/** Token realm issuing `tok:<scope>`, and a push registry accepting only push-scoped tokens. */
async function scopedRegistry(realmServer?: FakeServer) {
  let self: FakeServer | undefined;
  const issue = scopedTokenRealm();
  const { handler, store } = pushRegistry({
    accept: (a, req) => {
      const ok = req.method === 'GET' ? a?.startsWith('Bearer tok:') : a === `Bearer tok:${PUSH_SCOPE}`;
      return ok === true;
    },
  });
  const reg = await startServer(async (req, res) => {
    if ((req.url ?? '').startsWith('/token')) return issue(req, res);
    res.setHeader('www-authenticate', challenge(`${(realmServer ?? self)?.origin}/token`));
    return handler(req, res);
  });
  self = reg;
  return { reg, store };
}

describe('push auth', () => {
  it('requests a pull,push token, cached apart from the pull token', async () => {
    const { reg, store } = await scopedRegistry();
    const client = new OciClient({ insecureHosts: insecure });

    const { digest } = await client.pushBlob(ref(reg), PAYLOAD);
    const bytes = await client.blob(ref(reg), { mediaType: 'application/octet-stream', digest, size: PAYLOAD.length }, { maxBytes: 1024 });
    await client.pushBlob(ref(reg), PAYLOAD);

    expect(Buffer.from(bytes).equals(Buffer.from(PAYLOAD))).toBe(true);
    expect(store.blobs.has(digest)).toBe(true);
    const scopes = reg.requests.filter((r) => r.url.startsWith('/token')).map((r) => query(r).get('scope'));
    // One exchange per scope: the second push reuses the cached push token.
    expect(scopes).toEqual([PUSH_SCOPE, PULL_SCOPE]);
    const last = reg.requests.at(-1);
    expect(last?.method).toBe('HEAD');
    expect(last?.authorization).toBe(`Bearer tok:${PUSH_SCOPE}`);
  });

  it('does not send Basic credentials to an untrusted realm when pushing', async () => {
    const realm = await startServer(scopedTokenRealm());
    const { reg, store } = await scopedRegistry(realm);
    const client = new OciClient({ insecureHosts: insecure, credentials: { username: 'alice', password: 's3cret' } });

    await client.pushBlob(ref(reg), PAYLOAD);

    expect(store.blobs.size).toBe(1);
    expect(realm.requests).toHaveLength(1);
    expect(query(realm.requests[0]).get('scope')).toBe(PUSH_SCOPE);
    expect(realm.requests[0].authorization).toBeUndefined();
  });

  it('sends Basic credentials to a realm on the registry origin when pushing', async () => {
    const { reg } = await scopedRegistry();
    const client = new OciClient({ insecureHosts: insecure, credentials: { username: 'alice', password: 's3cret' } });
    await client.pushBlob(ref(reg), PAYLOAD);
    const tokenRequest = reg.requests.find((r) => r.url.startsWith('/token'));
    expect(tokenRequest?.authorization).toBe(basic('alice', 's3cret'));
  });

  it('sends {token} credentials straight to the registry', async () => {
    const realm = await startServer(tokenRealm({ token: 'never' }));
    const { handler, store } = pushRegistry({ challenge: challenge(`${realm.origin}/token`), accept: (a) => a === 'Bearer pat-1' });
    const reg = await startServer(handler);
    await new OciClient({ insecureHosts: insecure, credentials: { token: 'pat-1' } }).pushBlob(ref(reg), PAYLOAD);
    expect(store.blobs.size).toBe(1);
    expect(realm.requests).toHaveLength(0);
  });

  it('403 is DENIED', async () => {
    const realm = await startServer(tokenRealm({ token: 't' }));
    const { handler, store } = pushRegistry({ challenge: challenge(`${realm.origin}/token`), accept: (a) => (a ? 'deny' : false) });
    const reg = await startServer(handler);
    const err = await ociFailure(new OciClient({ insecureHosts: insecure }).pushBlob(ref(reg), PAYLOAD));
    expect(err.code).toBe('DENIED');
    expect(err.status).toBe(403);
    expect(store.blobs.size).toBe(0);
  });

  it('a 401 naming insufficient_scope after authenticating is DENIED', async () => {
    // An anonymous token that only grants pull: the registry keeps answering 401.
    const realm = await startServer(tokenRealm({ token: 'pull-only' }));
    const reg = await startServer((req, res) => {
      const authed = req.headers.authorization !== undefined;
      const header = authed
        ? `${challenge(`${realm.origin}/token`)},error="insufficient_scope"`
        : challenge(`${realm.origin}/token`);
      res.writeHead(401, { 'www-authenticate': header, 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ code: authed ? 'DENIED' : 'UNAUTHORIZED' }] }));
    });
    const err = await ociFailure(new OciClient({ insecureHosts: insecure }).pushBlob(ref(reg), PAYLOAD));
    expect(err.code).toBe('DENIED');
    expect(err.status).toBe(401);
  });

  it('a plain second 401 after authenticating stays UNAUTHORIZED', async () => {
    const realm = await startServer(tokenRealm({ token: 'rejected' }));
    const { handler } = pushRegistry({ challenge: challenge(`${realm.origin}/token`), accept: () => false });
    const reg = await startServer(handler);
    const err = await ociFailure(new OciClient({ insecureHosts: insecure }).pushBlob(ref(reg), PAYLOAD));
    expect(err.code).toBe('UNAUTHORIZED');
    expect(reg.requests).toHaveLength(2);
  });
});
