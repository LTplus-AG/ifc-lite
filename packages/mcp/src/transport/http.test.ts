/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Streamable HTTP session identity (#1030): a leaked Mcp-Session-Id must
 * not let a differently-scoped token end the session (destroying its
 * layer drafts), attach to its SSE stream, or reuse it for requests; and
 * a misconfigured SessionFactory that drops the session id must fail
 * loudly instead of pooling every HTTP session on the local workspace.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createMCPServer } from '../index.js';
import type { AuthScope } from '../auth/scope.js';
import { getLayerWorkspace, resetLayerWorkspace } from '../tools/layer-store.js';
import { BearerTokenAuth, HttpTransport, type SessionFactory } from './http.js';

const VERSION = '0.0.0-test';

const ALICE: AuthScope = { scopes: ['read', 'mutate'], user: 'alice' };
const MALLORY: AuthScope = { scopes: ['read', 'mutate'], user: 'mallory' };
// Same principal, same permissions — narrowed to *different* models. The only
// thing telling these two sessions apart is `modelIds`, which is what makes
// them the fixture for that arm of the identity check.
const ALICE_ALPHA: AuthScope = { scopes: ['read', 'mutate'], user: 'alice', modelIds: ['alpha'] };
const ALICE_BETA: AuthScope = { scopes: ['read', 'mutate'], user: 'alice', modelIds: ['beta'] };
// Same principal, same narrowing, but a wider permission set.
const ALICE_ADMIN: AuthScope = { scopes: ['read', 'mutate', 'admin'], user: 'alice' };
// Same permissions in a different order — must still compare equal.
const ALICE_REORDERED: AuthScope = { scopes: ['mutate', 'read'], user: 'alice' };

function makeTransport(factory?: SessionFactory): HttpTransport {
  return new HttpTransport({
    port: 0,
    host: '127.0.0.1',
    authenticator: new BearerTokenAuth(new Map([
      ['alice-token', ALICE],
      ['mallory-token', MALLORY],
      ['alice-alpha-token', ALICE_ALPHA],
      ['alice-beta-token', ALICE_BETA],
      ['alice-admin-token', ALICE_ADMIN],
      ['alice-reordered-token', ALICE_REORDERED],
    ])),
    sessionFactory: factory ?? {
      build: (scope, sessionId) => createMCPServer({ version: VERSION, scope, sessionId }),
    },
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'http-test', version: '0' },
  },
});

async function request(
  port: number,
  token: string,
  // `headers` is replaced rather than intersected: intersecting with
  // `HeadersInit` would leave `Headers`/`string[][]` in the union and those
  // do not spread into a `Record<string, string>`.
  init: Omit<RequestInit, 'headers'> & { sessionId?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  // Caller headers merge over the defaults so tests can add e.g. Accept.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(init.sessionId !== undefined ? { 'Mcp-Session-Id': init.sessionId } : {}),
    ...init.headers,
  };
  return fetch(`http://127.0.0.1:${port}/`, { ...init, headers });
}

async function initSession(port: number, token: string): Promise<string> {
  const res = await request(port, token, { method: 'POST', body: INITIALIZE });
  expect(res.status).toBe(200);
  const sid = res.headers.get('mcp-session-id');
  expect(sid).toBeTruthy();
  return sid as string;
}

describe('HttpTransport session identity', () => {
  let transport: HttpTransport;
  let port: number;

  beforeEach(async () => {
    resetLayerWorkspace();
    transport = makeTransport();
    await transport.listen();
    port = transport.port() as number;
    expect(port).toBeGreaterThan(0);
  });

  afterEach(async () => {
    await transport.close();
    resetLayerWorkspace();
  });

  it('DELETE with a foreign token is rejected and disposes nothing', async () => {
    const sid = await initSession(port, 'alice-token');
    // Mark Alice's per-session draft space so disposal is observable.
    const drafts = getLayerWorkspace(sid).drafts;
    drafts.set('marker', { id: 'marker', doc: new Y.Doc() } as never);

    const denied = await request(port, 'mallory-token', { method: 'DELETE', sessionId: sid });
    expect(denied.status).toBe(403);
    expect(getLayerWorkspace(sid).drafts.has('marker')).toBe(true);

    // The bound principal may end its own session; drafts go with it.
    const ok = await request(port, 'alice-token', { method: 'DELETE', sessionId: sid });
    expect(ok.status).toBe(204);
    expect(getLayerWorkspace(sid).drafts.size).toBe(0);
  });

  it('GET (SSE attach) with a foreign token is rejected', async () => {
    const sid = await initSession(port, 'alice-token');
    const denied = await request(port, 'mallory-token', {
      method: 'GET',
      sessionId: sid,
      headers: { Accept: 'text/event-stream' },
    });
    expect(denied.status).toBe(403);
  });

  it('POST with a foreign token cannot reuse the session', async () => {
    const sid = await initSession(port, 'alice-token');
    const denied = await request(port, 'mallory-token', {
      method: 'POST',
      sessionId: sid,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    expect(denied.status).toBe(403);
  });

  // The three tests above all differ by `user`, which `sameScope` rejects on
  // its very first comparison — so every later arm of the check (the scope-set
  // comparison, the `modelIds` comparison) was unreachable and could be
  // deleted. A token narrowed to one model could then take over a session
  // opened by a token narrowed to another, and inherit its drafts.
  it('a token narrowed to a different model cannot reuse the session', async () => {
    const sid = await initSession(port, 'alice-alpha-token');
    const denied = await request(port, 'alice-beta-token', {
      method: 'POST',
      sessionId: sid,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    expect(denied.status).toBe(403);

    // Counter-example: the identical token does reuse it, so the rejection is
    // about the narrowing and not about session reuse being broken outright.
    const ok = await request(port, 'alice-alpha-token', {
      method: 'POST',
      sessionId: sid,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    });
    expect(ok.status).toBe(200);
  });

  it('an unnarrowed token cannot reuse a narrowed session, or the reverse', async () => {
    const narrowed = await initSession(port, 'alice-alpha-token');
    expect((await request(port, 'alice-token', {
      method: 'POST', sessionId: narrowed,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    })).status).toBe(403);

    const wide = await initSession(port, 'alice-token');
    expect((await request(port, 'alice-alpha-token', {
      method: 'POST', sessionId: wide,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    })).status).toBe(403);
  });

  it('a wider permission set cannot reuse a narrower session', async () => {
    const sid = await initSession(port, 'alice-token');
    const denied = await request(port, 'alice-admin-token', {
      method: 'POST', sessionId: sid,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    expect(denied.status).toBe(403);
  });

  it('the same permission set in a different order still reuses the session', async () => {
    // The sort in `sameScope` exists for this; without it a client that emitted
    // its scopes in another order would be locked out of its own session.
    const sid = await initSession(port, 'alice-token');
    const ok = await request(port, 'alice-reordered-token', {
      method: 'POST', sessionId: sid,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    expect(ok.status).toBe(200);
  });
});

describe('HttpTransport session factory contract', () => {
  it('rejects factories that build servers without binding the session id', async () => {
    const transport = makeTransport({
      // Deployment bug under test: scope-only construction.
      build: (scope) => createMCPServer({ version: VERSION, scope }),
    });
    await transport.listen();
    try {
      const res = await request(transport.port() as number, 'alice-token', {
        method: 'POST',
        body: INITIALIZE,
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/sessionId/);
    } finally {
      await transport.close();
    }
  });
});

const PING = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function capped(limits: { maxSessions?: number; sessionIdleMs?: number }, factory?: SessionFactory): HttpTransport {
  return new HttpTransport({
    port: 0,
    host: '127.0.0.1',
    authenticator: new BearerTokenAuth(new Map([['alice-token', ALICE], ['mallory-token', MALLORY]])),
    sessionFactory: factory ?? { build: (scope, sessionId) => createMCPServer({ version: VERSION, scope, sessionId }) },
    ...limits,
  });
}

/**
 * Session allowance: `initialize` is the only request that creates a session
 * and, before the cap, only `DELETE` removed one, so a client that never ends
 * its sessions grew the map (and the MCPServer and layer workspace behind each
 * entry) without limit.
 */
describe('HttpTransport session capacity', () => {
  let transport: HttpTransport | undefined;
  beforeEach(() => resetLayerWorkspace());
  afterEach(async () => {
    await transport?.close();
    transport = undefined;
    resetLayerWorkspace();
  });

  it('refuses initialize with 503 once maxSessions live sessions exist', async () => {
    transport = capped({ maxSessions: 3 });
    await transport.listen();
    const port = transport.port() as number;
    for (let i = 0; i < 3; i++) await initSession(port, 'alice-token');
    const over = await request(port, 'alice-token', { method: 'POST', body: INITIALIZE });
    expect(over.status).toBe(503);
    expect(over.headers.get('mcp-session-id')).toBeNull();
  });

  it('ending a session frees its slot', async () => {
    transport = capped({ maxSessions: 1 });
    await transport.listen();
    const port = transport.port() as number;
    const sid = await initSession(port, 'alice-token');
    expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(503);
    await request(port, 'alice-token', { method: 'DELETE', sessionId: sid });
    expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(200);
  });

  it('at the cap, reclaims only sessions idle past sessionIdleMs, and disposes their drafts', async () => {
    transport = capped({ maxSessions: 2, sessionIdleMs: 150 });
    await transport.listen();
    const port = transport.port() as number;
    const stale = await initSession(port, 'alice-token');
    const busy = await initSession(port, 'alice-token');
    getLayerWorkspace(stale).drafts.set('marker', { id: 'marker', doc: new Y.Doc() } as never);

    await sleep(200);
    // `busy` is used again, so only `stale` has been idle for the whole window.
    const touched = await request(port, 'alice-token', { method: 'POST', sessionId: busy, body: PING(2) });
    expect(touched.status).toBe(200);

    const fresh = await request(port, 'alice-token', { method: 'POST', body: INITIALIZE });
    expect(fresh.status).toBe(200);
    expect(getLayerWorkspace(stale).drafts.size).toBe(0);
    // The reclaimed session no longer exists; the busy one survived.
    expect((await request(port, 'alice-token', { method: 'POST', sessionId: stale, body: PING(3) })).status).toBe(404);
    expect((await request(port, 'alice-token', { method: 'POST', sessionId: busy, body: PING(4) })).status).toBe(200);
  });

  it('never reclaims a session that has an open SSE stream, however idle', async () => {
    transport = capped({ maxSessions: 1, sessionIdleMs: 1 });
    await transport.listen();
    const port = transport.port() as number;
    const sid = await initSession(port, 'alice-token');
    const ac = new AbortController();
    const sse = await request(port, 'alice-token', {
      method: 'GET', sessionId: sid, headers: { Accept: 'text/event-stream' }, signal: ac.signal,
    });
    expect(sse.status).toBe(200);
    try {
      await sleep(20);
      expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(503);
    } finally {
      ac.abort();
    }
  });

  it('counts sessions whose factory is still building against the cap', async () => {
    transport = capped({ maxSessions: 1 }, {
      build: async (scope, sessionId) => {
        await sleep(50);
        return createMCPServer({ version: VERSION, scope, sessionId });
      },
    });
    await transport.listen();
    const port = transport.port() as number;
    const results = await Promise.all(
      [0, 1, 2, 3].map(() => request(port, 'alice-token', { method: 'POST', body: INITIALIZE })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 503, 503, 503]);
  });
});

/**
 * Review of the session cap (#6943): the cap's arithmetic under concurrency and
 * failure, which sessions the reclaim may take, and what a client is told when
 * its session was ended for it.
 */
describe('HttpTransport session capacity: arithmetic, reclaim policy, signalling', () => {
  let transport: HttpTransport | undefined;
  beforeEach(() => resetLayerWorkspace());
  afterEach(async () => {
    await transport?.close();
    transport = undefined;
    resetLayerWorkspace();
  });

  const draft = (sid: string) => getLayerWorkspace(sid).drafts.set('d', { id: 'd', doc: new Y.Doc() } as never);
  const live = async (port: number, sid: string) =>
    (await request(port, 'alice-token', { method: 'POST', sessionId: sid, body: PING(9) })).status;

  /** A factory whose builds stay pending until `release()`. */
  function deferredFactory() {
    const waiting: Array<() => void> = [];
    const factory: SessionFactory = {
      build: (scope, sessionId) => new Promise((resolve) => {
        waiting.push(() => resolve(createMCPServer({ version: VERSION, scope, sessionId })));
      }),
    };
    return { factory, pending: () => waiting.length, release: () => waiting.splice(0).forEach((f) => f()) };
  }

  it('default cap is 1000: the 1001st initialize is refused (no option passed)', async () => {
    transport = capped({});
    await transport.listen();
    const port = transport.port() as number;
    for (let i = 0; i < 1000; i++) {
      const res = await request(port, 'alice-token', { method: 'POST', body: INITIALIZE });
      if (res.status !== 200) throw new Error(`initialize ${i + 1} answered ${res.status}`);
    }
    expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(503);
  }, 60_000);

  it('N concurrent initializes at cap-1 admit exactly one while their factories are pending', async () => {
    const d = deferredFactory();
    transport = capped({ maxSessions: 3 }, d.factory);
    await transport.listen();
    const port = transport.port() as number;
    const first = [0, 1].map(() => request(port, 'alice-token', { method: 'POST', body: INITIALIZE }));
    while (d.pending() < 2) await sleep(5);
    d.release();
    await Promise.all(first);
    // Two live, cap 3: five at once, none has finished building yet.
    const burst = [0, 1, 2, 3, 4].map(() => request(port, 'alice-token', { method: 'POST', body: INITIALIZE }));
    while (d.pending() < 1) await sleep(5);
    await sleep(100);
    expect(d.pending()).toBe(1);
    d.release();
    expect((await Promise.all(burst)).map((r) => r.status).sort()).toEqual([200, 503, 503, 503, 503]);
  });

  it('a factory that throws, or returns the wrong session id, does not keep its slot', async () => {
    let call = 0;
    transport = capped({ maxSessions: 1 }, {
      build: (scope, sessionId) => {
        call++;
        if (call === 1) throw new Error('factory exploded');
        if (call === 2) return createMCPServer({ version: VERSION, scope, sessionId: 'not-the-id' });
        return createMCPServer({ version: VERSION, scope, sessionId });
      },
    });
    await transport.listen();
    const port = transport.port() as number;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(500);
      expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(500);
    } finally {
      errSpy.mockRestore();
    }
    expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(200);
  });

  it('frees one slot per initialize, oldest idle first, not every idle session', async () => {
    transport = capped({ maxSessions: 3, sessionIdleMs: 50 });
    await transport.listen();
    const port = transport.port() as number;
    const a = await initSession(port, 'alice-token');
    await sleep(20);
    const b = await initSession(port, 'alice-token');
    await sleep(20);
    const c = await initSession(port, 'alice-token');
    await sleep(80);
    expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(200);
    expect(await live(port, a)).toBe(404);
    expect(await live(port, b)).toBe(200);
    expect(await live(port, c)).toBe(200);
  });

  it('prefers to end an idle session with no unpublished drafts over an older one that holds drafts', async () => {
    transport = capped({ maxSessions: 2, sessionIdleMs: 50 });
    await transport.listen();
    const port = transport.port() as number;
    const withDraft = await initSession(port, 'alice-token');
    draft(withDraft);
    await sleep(20);
    const bare = await initSession(port, 'alice-token');
    await sleep(80);
    expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(200);
    expect(getLayerWorkspace(withDraft).drafts.size).toBe(1);
    expect(await live(port, withDraft)).toBe(200);
    expect(await live(port, bare)).toBe(404);
  });

  it('answers a request for an ended session with 404 and a body that says why and what to do', async () => {
    transport = capped({ maxSessions: 1, sessionIdleMs: 30 });
    await transport.listen();
    const port = transport.port() as number;
    const gone = await initSession(port, 'alice-token');
    await sleep(60);
    expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(200);
    const res = await request(port, 'alice-token', { method: 'POST', sessionId: gone, body: PING(2) });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('unknown-session');
    expect(body.message).toMatch(/idle/);
    expect(body.message).toMatch(/initialize/);
    // No header at all stays a client error, not a "session ended" signal.
    expect((await request(port, 'alice-token', { method: 'POST', body: PING(3) })).status).toBe(400);
  });

  it('a session whose SSE stream just closed is not idle (the stream was activity)', async () => {
    transport = capped({ maxSessions: 1, sessionIdleMs: 150 });
    await transport.listen();
    const port = transport.port() as number;
    const sid = await initSession(port, 'alice-token');
    const ac = new AbortController();
    const sse = await request(port, 'alice-token', {
      method: 'GET', sessionId: sid, headers: { Accept: 'text/event-stream' }, signal: ac.signal,
    });
    expect(sse.status).toBe(200);
    await sleep(250);
    ac.abort();
    await sleep(40);
    expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(503);
    expect(await live(port, sid)).toBe(200);
  });

  it("a request refused for scope mismatch does not keep another principal's session alive", async () => {
    transport = capped({ maxSessions: 1, sessionIdleMs: 80 });
    await transport.listen();
    const port = transport.port() as number;
    const sid = await initSession(port, 'alice-token');
    await sleep(120);
    const probe = await request(port, 'mallory-token', { method: 'POST', sessionId: sid, body: PING(2) });
    expect(probe.status).toBe(403);
    expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(200);
  });

  it('a session with a request still in flight is not idle', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    transport = capped({ maxSessions: 1, sessionIdleMs: 30 }, {
      build: (scope, sessionId) => {
        const server = createMCPServer({ version: VERSION, scope, sessionId });
        const handle = server.handleMessage.bind(server);
        server.handleMessage = async (m) => {
          if ((m as { method?: string }).method === 'ping') await gate;
          return handle(m);
        };
        return server;
      },
    });
    await transport.listen();
    const port = transport.port() as number;
    const sid = await initSession(port, 'alice-token');
    const slow = request(port, 'alice-token', { method: 'POST', sessionId: sid, body: PING(2) });
    await sleep(100);
    expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(503);
    release();
    expect((await slow).status).toBe(200);
    // Idle time starts when the call settles, not when it began.
    expect((await request(port, 'alice-token', { method: 'POST', body: INITIALIZE })).status).toBe(503);
  });
});
