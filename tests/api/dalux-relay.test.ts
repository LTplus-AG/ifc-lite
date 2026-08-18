/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDaluxRelayHandler, loadDaluxRelayConfig, resolveUpstreamPath, DEFAULT_DALUX_RELAY_CONFIG, type DaluxRelayConfig } from '../../server/sources/dalux-relay.js';

const APP_ORIGIN = 'https://app.example';

function createConfig(overrides: Partial<DaluxRelayConfig> = {}): DaluxRelayConfig {
  return { ...DEFAULT_DALUX_RELAY_CONFIG, allowedOrigins: [APP_ORIGIN], ...overrides };
}

interface Captured {
  url: string;
  headers: Headers;
  method: string;
}

function createHandler(
  overrides: Partial<DaluxRelayConfig> = {},
  respond: () => Response = () => new Response('{"items":[]}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': 'upstream=1' },
  }),
) {
  const captured: Captured[] = [];
  const handler = createDaluxRelayHandler(createConfig(overrides), {
    fetchImpl: async (input, init) => {
      captured.push({
        url: String(input),
        headers: new Headers(init?.headers),
        method: init?.method ?? 'GET',
      });
      return respond();
    },
  });
  return { handler, captured };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${APP_ORIGIN}${path}`, {
    method: 'GET',
    headers: { 'x-api-key': 'caller-key', ...headers },
  });
}

test('forwards an allowed path to the upstream base path', async () => {
  const { handler, captured } = createHandler();
  const response = await handler(get('/api/dalux/5.1/projects?limit=10'));

  assert.equal(response.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(
    captured[0].url,
    'https://node1.field.dalux.com/service/api/5.1/projects?limit=10',
  );
  assert.equal(captured[0].headers.get('x-api-key'), 'caller-key');
});

test('rejects every method except GET, HEAD and OPTIONS', async () => {
  const { handler, captured } = createHandler();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await handler(
      new Request(`${APP_ORIGIN}/api/dalux/5.1/projects`, {
        method,
        headers: { 'x-api-key': 'caller-key' },
      }),
    );
    assert.equal(response.status, 405, `${method} should be rejected`);
  }
  assert.equal(captured.length, 0, 'no write method should reach upstream');
});

test('requires a caller-supplied API key', async () => {
  const { handler, captured } = createHandler();
  const response = await handler(
    new Request(`${APP_ORIGIN}/api/dalux/5.1/projects`, { method: 'GET' }),
  );

  assert.equal(response.status, 401);
  assert.equal(captured.length, 0, 'anonymous requests must not reach upstream');
});

test('never forwards cookies or authorization upstream', async () => {
  const { handler, captured } = createHandler();
  await handler(
    get('/api/dalux/5.1/projects', {
      cookie: 'session=secret; _vercel_jwt=deployment-token',
      authorization: 'Bearer app-token',
    }),
  );

  assert.equal(captured[0].headers.get('cookie'), null);
  assert.equal(captured[0].headers.get('authorization'), null);
});

test('never passes upstream set-cookie back to the browser', async () => {
  const { handler } = createHandler();
  const response = await handler(get('/api/dalux/5.1/projects'));

  assert.equal(response.headers.get('set-cookie'), null);
});

test('rejects a disallowed cross-site origin without contacting upstream', async () => {
  const { handler, captured } = createHandler();
  const response = await handler(get('/api/dalux/5.1/projects', { origin: 'https://evil.example' }));

  assert.equal(response.status, 403);
  assert.equal(captured.length, 0);
});

test('echoes CORS headers only for an allowed origin', async () => {
  const { handler } = createHandler();
  const response = await handler(get('/api/dalux/5.1/projects', { origin: APP_ORIGIN }));

  assert.equal(response.headers.get('access-control-allow-origin'), APP_ORIGIN);
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');
});

test('rejects paths outside the allowed API versions', async () => {
  const { handler, captured } = createHandler();
  for (const path of ['/api/dalux/admin/users', '/api/dalux/9.9/projects', '/api/dalux/']) {
    const response = await handler(get(path));
    assert.ok(response.status >= 400, `${path} should be rejected`);
  }
  assert.equal(captured.length, 0);
});

test('resolveUpstreamPath rejects traversal in raw and encoded form', () => {
  const config = createConfig();
  for (const attempt of [
    '5.1/../../admin',
    '5.1/%2e%2e/admin',
    '%2e%2e%2fadmin',
    '/5.1/projects',
    'https://evil.example/5.1',
    '5.1//projects',
    '5.1/\\admin',
  ]) {
    assert.equal(resolveUpstreamPath(attempt, config), null, `${attempt} should be rejected`);
  }
});

test('resolveUpstreamPath re-encodes legitimate segments', () => {
  const config = createConfig();
  assert.equal(
    resolveUpstreamPath('5.1/projects/my%20project', config),
    '5.1/projects/my%20project',
  );
});

test('upstream failure does not echo request headers', async () => {
  const { handler } = createHandler({}, () => {
    throw new Error('boom');
  });
  const handlerWithThrow = createDaluxRelayHandler(createConfig(), {
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });

  const response = await handlerWithThrow(get('/api/dalux/5.1/projects'));
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.ok(!body.includes('caller-key'), 'error body must not leak the caller key');
  void handler;
});

test('accepts the rewrite path parameter and does not forward it upstream', async () => {
  const { handler, captured } = createHandler();
  const response = await handler(
    new Request(`${APP_ORIGIN}/api/dalux?path=5.1%2Fprojects&limit=10`, {
      method: 'GET',
      headers: { 'x-api-key': 'caller-key' },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(
    captured[0].url,
    'https://node1.field.dalux.com/service/api/5.1/projects?limit=10',
  );
});

test('refuses an off-host redirect rather than re-sending the key to it', async () => {
  // The exact credential-exfil path: an open redirect on any allowed Dalux
  // endpoint would, if followed, hand X-API-KEY to the target host.
  const seen: string[] = [];
  const handler = createDaluxRelayHandler(createConfig(), {
    fetchImpl: async (input) => {
      seen.push(String(input));
      if (String(input).includes('node1.field.dalux.com')) {
        return new Response(null, { status: 302, headers: { location: 'https://attacker.example/steal' } });
      }
      return new Response('pwned', { status: 200 });
    },
  });

  const response = await handler(get('/api/dalux/5.1/projects?returnUrl=x'));

  assert.equal(response.status, 502);
  assert.ok(
    !seen.some((url) => url.includes('attacker.example')),
    'the relay must never issue a request to the redirect target',
  );
});

test('follows a same-host redirect and forwards the key only to the upstream host', async () => {
  const seen: string[] = [];
  const handler = createDaluxRelayHandler(createConfig(), {
    fetchImpl: async (input, init) => {
      const url = String(input);
      seen.push(url);
      assert.equal(new Headers(init?.headers).get('x-api-key'), 'caller-key');
      if (url.endsWith('/5.1/projects')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://node1.field.dalux.com/service/api/5.1/projects?page=2' },
        });
      }
      return new Response('{"items":[]}', { status: 200 });
    },
  });

  const response = await handler(get('/api/dalux/5.1/projects'));

  assert.equal(response.status, 200);
  assert.equal(seen.length, 2, 'should follow the one same-host hop');
  assert.ok(seen.every((url) => url.startsWith('https://node1.field.dalux.com')));
});

test('stops after a bounded number of same-host redirects', async () => {
  let hops = 0;
  const handler = createDaluxRelayHandler(createConfig(), {
    fetchImpl: async () => {
      hops++;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://node1.field.dalux.com/service/api/5.1/loop' },
      });
    },
  });

  const response = await handler(get('/api/dalux/5.1/projects'));
  assert.equal(response.status, 502);
  assert.ok(hops <= 5, `redirect loop must be bounded, saw ${hops} hops`);
});

test('loadDaluxRelayConfig parses a comma-separated origin list', () => {
  const config = loadDaluxRelayConfig({
    DALUX_RELAY_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
  });

  assert.deepEqual(config.allowedOrigins, ['https://a.example', 'https://b.example']);
  assert.equal(config.upstreamOrigin, 'https://node1.field.dalux.com');
});

// --- per-node routing (#2792) -------------------------------------------------
// Dalux assigns each customer a node and shows the base URL beside the API key.
// Before this, every user on node2+ was locked out of Dalux Box entirely.

test('routes to the caller-selected node', async () => {
  const { handler, captured } = createHandler();
  const response = await handler(get('/api/dalux/5.1/projects?daluxNode=node2&limit=10'));

  assert.equal(response.status, 200);
  assert.equal(
    captured[0].url,
    'https://node2.field.dalux.com/service/api/5.1/projects?limit=10',
  );
});

test('the node selector is never forwarded as a Dalux query param', async () => {
  const { handler, captured } = createHandler();
  await handler(get('/api/dalux/5.1/projects?daluxNode=node7'));

  assert.equal(captured[0].url, 'https://node7.field.dalux.com/service/api/5.1/projects');
  assert.ok(!captured[0].url.includes('daluxNode'), 'routing param leaked upstream');
});

test('falls back to the default node when none is given', async () => {
  const { handler, captured } = createHandler();
  await handler(get('/api/dalux/5.1/projects'));
  assert.ok(captured[0].url.startsWith('https://node1.field.dalux.com'));
});

test('refuses a node that is not a Dalux field node', async () => {
  // The relay forwards the caller's X-API-KEY. Accepting a caller-supplied
  // host would make it an open proxy that leaks that key anywhere, so the
  // origin is assembled here from a name and never taken from the request.
  const hostile = [
    'evil.com',
    'node1.field.dalux.com.evil.com',
    'node1.field.dalux.com/../..',
    'node0',
    'node',
    'node01',
    'NODE2',
    'node2 ',
    'node2/x',
    'node2:8080',
    'node2#',
    'user@node2',
    '../node2',
    'node9999',
    'https://node2.field.dalux.com',
  ];
  for (const node of hostile) {
    const { handler, captured } = createHandler();
    const response = await handler(
      get(`/api/dalux/5.1/projects?daluxNode=${encodeURIComponent(node)}`),
    );
    assert.equal(response.status, 400, `${node} was not rejected`);
    assert.equal(captured.length, 0, `${node} reached the network`);
  }
});

test('accepts the full documented node range', async () => {
  for (const node of ['node1', 'node2', 'node9', 'node10', 'node123']) {
    const { handler, captured } = createHandler();
    const response = await handler(get(`/api/dalux/5.1/projects?daluxNode=${node}`));
    assert.equal(response.status, 200, `${node} was rejected`);
    assert.equal(captured[0].url, `https://${node}.field.dalux.com/service/api/5.1/projects`);
  }
});
