/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'vitest';
import { OciClient, OciError, parseReference } from '../src/index.js';
import { basic, closeAll, query, registry, startServer, tokenRealm, type FakeServer } from './fake-registry.js';

afterEach(closeAll);

const TAGS = { '/v2/team/model/tags/list': { body: JSON.stringify({ name: 'team/model', tags: ['v1'] }) } };

function bearerChallenge(realm: string): string {
  // GHCR's shape, including the placeholder scope it sends on every challenge.
  return `Bearer realm="${realm}",service="fake-registry",scope="repository:user/image:pull"`;
}

function ref(server: FakeServer) {
  return parseReference(`${server.host}/team/model:v1`, { insecureHosts: ['127.0.0.1'] });
}

async function failure(promise: Promise<unknown>): Promise<OciError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OciError);
    return err as OciError;
  }
  throw new Error('expected the call to reject');
}

/** Registry accepting exactly `Bearer <token>`; realm on its own server. */
async function bearerRegistry(realm: FakeServer | 'self', token: string, reply: Record<string, unknown>) {
  let self: FakeServer | undefined;
  const reg = await startServer(async (req, res) => {
    if ((req.url ?? '').startsWith('/token')) return tokenRealm(reply)(req, res);
    const realmUrl = realm === 'self' ? `${self?.origin}/token` : `${realm.origin}/token`;
    return registry({ challenge: bearerChallenge(realmUrl), accept: (a) => a === `Bearer ${token}`, routes: TAGS })(req, res);
  });
  self = reg;
  return reg;
}

describe('bearer token flow', () => {
  it('anonymous: token-only reply without expires_in, own scope, cached for the default lifetime', async () => {
    const realm = await startServer(tokenRealm({ token: 'anon-1' }));
    const reg = await bearerRegistry(realm, 'anon-1', {});
    const client = new OciClient({ insecureHosts: ['127.0.0.1'] });

    expect(await client.tags(ref(reg))).toEqual(['v1']);
    expect(realm.requests).toHaveLength(1);
    const q = query(realm.requests[0]);
    expect(q.get('service')).toBe('fake-registry');
    expect(q.get('scope')).toBe('repository:team/model:pull');
    expect(realm.requests[0].authorization).toBeUndefined();
    expect(reg.requests.map((r) => r.authorization)).toEqual([undefined, 'Bearer anon-1']);

    // Second call reuses the cached token: no new realm hit, no 401 round trip.
    expect(await client.tags(ref(reg))).toEqual(['v1']);
    expect(realm.requests).toHaveLength(1);
    expect(reg.requests.at(-1)?.authorization).toBe('Bearer anon-1');
    expect(reg.requests).toHaveLength(3);
  });

  it('accepts an access_token-only reply', async () => {
    const realm = await startServer(tokenRealm({ access_token: 'oauth-style', expires_in: 300 }));
    const reg = await bearerRegistry(realm, 'oauth-style', {});
    expect(await new OciClient({ insecureHosts: ['127.0.0.1'] }).tags(ref(reg))).toEqual(['v1']);
  });

  it('sends Basic credentials to a realm on the registry origin', async () => {
    const reg = await bearerRegistry('self', 'issued', { token: 'issued' });
    const client = new OciClient({ insecureHosts: ['127.0.0.1'], credentials: { username: 'alice', password: 's3cret' } });
    expect(await client.tags(ref(reg))).toEqual(['v1']);
    const tokenRequest = reg.requests.find((r) => r.url.startsWith('/token'));
    expect(tokenRequest?.authorization).toBe(basic('alice', 's3cret'));
  });

  it('never sends credentials to a foreign realm, and requests the token anonymously instead', async () => {
    const realm = await startServer(tokenRealm({ token: 'anon' }));
    const reg = await bearerRegistry(realm, 'anon', {});
    const client = new OciClient({ insecureHosts: ['127.0.0.1'], credentials: { username: 'alice', password: 's3cret' } });
    expect(await client.tags(ref(reg))).toEqual(['v1']);
    expect(realm.requests).toHaveLength(1);
    expect(realm.requests[0].authorization).toBeUndefined();
  });

  it('sends credentials to a foreign realm listed in trustedRealms', async () => {
    const realm = await startServer(tokenRealm({ token: 'authed' }));
    const reg = await bearerRegistry(realm, 'authed', {});
    const client = new OciClient({
      insecureHosts: ['127.0.0.1'],
      credentials: { username: 'alice', password: 's3cret' },
      trustedRealms: [`${realm.origin}/some/path`],
    });
    expect(await client.tags(ref(reg))).toEqual(['v1']);
    expect(realm.requests[0].authorization).toBe(basic('alice', 's3cret'));
  });

  it('sends {token} credentials straight to the registry without a realm exchange', async () => {
    const realm = await startServer(tokenRealm({ token: 'never' }));
    const reg = await bearerRegistry(realm, 'pat-123', {});
    const client = new OciClient({ insecureHosts: ['127.0.0.1'], credentials: { token: 'pat-123' } });
    expect(await client.tags(ref(reg))).toEqual(['v1']);
    expect(realm.requests).toHaveLength(0);
    expect(reg.requests.at(-1)?.authorization).toBe('Bearer pat-123');
  });

  it('fetches a new token once the cached one has expired', async () => {
    let issued = 0;
    const realm = await startServer(tokenRealm(() => ({ token: `t${++issued}`, expires_in: 1 })));
    const reg = await startServer(
      registry({ challenge: bearerChallenge(`${realm.origin}/token`), accept: (a) => a === `Bearer t${issued}`, routes: TAGS }),
    );
    const client = new OciClient({ insecureHosts: ['127.0.0.1'] });
    await client.tags(ref(reg));
    // expires_in=1 is inside the client's 5 s expiry margin, so the token is
    // already stale on the next call and must be replaced, not replayed.
    await client.tags(ref(reg));
    expect(realm.requests).toHaveLength(2);
    expect(reg.requests.map((r) => r.authorization)).toEqual([undefined, 'Bearer t1', undefined, 'Bearer t2']);
  });

  it('re-authenticates once when the registry rejects a cached token', async () => {
    let issued = 0;
    const realm = await startServer(tokenRealm(() => ({ token: `t${++issued}` })));
    const reg = await startServer(
      registry({ challenge: bearerChallenge(`${realm.origin}/token`), accept: (a) => a === `Bearer t${issued}`, routes: TAGS }),
    );
    const client = new OciClient({ insecureHosts: ['127.0.0.1'] });
    await client.tags(ref(reg));
    issued++; // server-side revocation: t1 no longer accepted
    expect(await client.tags(ref(reg))).toEqual(['v1']);
    expect(reg.requests.map((r) => r.authorization)).toEqual([undefined, 'Bearer t1', 'Bearer t1', 'Bearer t3']);
  });

  it('a second 401 after authenticating is UNAUTHORIZED, and the message carries no secret', async () => {
    const realm = await startServer(tokenRealm({ token: 'tok-SECRET' }));
    const reg = await startServer(registry({ challenge: bearerChallenge(`${realm.origin}/token`), accept: () => false, routes: TAGS }));
    const client = new OciClient({
      insecureHosts: ['127.0.0.1'],
      credentials: { username: 'alice', password: 'pw-SECRET' },
      trustedRealms: [realm.origin],
    });
    const err = await failure(client.tags(ref(reg)));
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.status).toBe(401);
    expect(err.message).not.toMatch(/SECRET/);
    expect(reg.requests).toHaveLength(2);
  });

  it('403 is DENIED', async () => {
    const realm = await startServer(tokenRealm({ token: 't' }));
    const reg = await startServer(
      registry({ challenge: bearerChallenge(`${realm.origin}/token`), accept: (a) => (a ? 'deny' : false), routes: TAGS }),
    );
    const err = await failure(new OciClient({ insecureHosts: ['127.0.0.1'] }).tags(ref(reg)));
    expect(err.code).toBe('DENIED');
    expect(err.status).toBe(403);
  });

  it('a realm that rejects the credentials is UNAUTHORIZED', async () => {
    const reg = await startServer(async (req, res) => {
      if ((req.url ?? '').startsWith('/token')) {
        res.writeHead(401).end();
        return;
      }
      return registry({ challenge: bearerChallenge(`http://${req.headers.host}/token`), accept: () => false, routes: TAGS })(req, res);
    });
    const client = new OciClient({ insecureHosts: ['127.0.0.1'], credentials: { username: 'a', password: 'b' } });
    expect((await failure(client.tags(ref(reg)))).code).toBe('UNAUTHORIZED');
  });

  it('refuses a plain-http realm whose host is not insecure', async () => {
    const realm = await startServer(tokenRealm({ token: 't' }));
    const reg = await bearerRegistry(realm, 't', {});
    // Only the registry's own host:port is insecure; the realm's port is not.
    const client = new OciClient({ insecureHosts: [reg.host], credentials: { username: 'a', password: 'b' } });
    const err = await failure(client.tags(parseReference(`${reg.host}/team/model`, { insecureHosts: [reg.host] })));
    expect(err.code).toBe('PROTOCOL');
    expect(err.message).toMatch(/plain-http token realm/);
    expect(realm.requests).toHaveLength(0);
  });

  it('picks Bearer out of several challenges and keeps quoted commas intact', async () => {
    const realm = await startServer(tokenRealm({ token: 't' }));
    const challenge = `Basic realm="registry", Bearer realm="${realm.origin}/token",service="svc,with,commas",scope="repository:x:pull,push"`;
    const reg = await startServer(registry({ challenge, accept: (a) => a === 'Bearer t', routes: TAGS }));
    expect(await new OciClient({ insecureHosts: ['127.0.0.1'] }).tags(ref(reg))).toEqual(['v1']);
    expect(query(realm.requests[0]).get('service')).toBe('svc,with,commas');
    expect(query(realm.requests[0]).get('scope')).toBe('repository:team/model:pull');
  });
});

describe('basic challenge', () => {
  it('sends Basic credentials to the registry', async () => {
    const reg = await startServer(
      registry({ challenge: 'Basic realm="fake"', accept: (a) => a === basic('bob', 'pw'), routes: TAGS }),
    );
    const client = new OciClient({ insecureHosts: ['127.0.0.1'], credentials: { username: 'bob', password: 'pw' } });
    expect(await client.tags(ref(reg))).toEqual(['v1']);
    expect(reg.requests.map((r) => r.authorization)).toEqual([undefined, basic('bob', 'pw')]);
  });

  it('without credentials is UNAUTHORIZED', async () => {
    const reg = await startServer(registry({ challenge: 'Basic realm="fake"', accept: () => false, routes: TAGS }));
    const err = await failure(new OciClient({ insecureHosts: ['127.0.0.1'] }).tags(ref(reg)));
    expect(err.code).toBe('UNAUTHORIZED');
    expect(reg.requests).toHaveLength(1);
  });

  it('a 401 with no challenge is UNAUTHORIZED', async () => {
    const reg = await startServer(registry({ accept: () => false, routes: TAGS }));
    const err = await failure(new OciClient({ insecureHosts: ['127.0.0.1'] }).tags(ref(reg)));
    expect(err.code).toBe('UNAUTHORIZED');
    expect(err.message).toMatch(/without a WWW-Authenticate/);
  });
});
