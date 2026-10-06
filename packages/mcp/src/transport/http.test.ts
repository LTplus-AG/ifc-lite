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
/** The idle window every session-cap test below uses, in (faked) wall-clock ms. */
const IDLE = 60_000;

function capped(limits: { maxSessions?: number; sessionIdleMs?: number }, factory?: SessionFactory): HttpTransport {
  return new HttpTransport({
    port: 0,
    host: '127.0.0.1',
    authenticator: new BearerTokenAuth(new Map([['alice-token', ALICE], ['mallory-token', MALLORY]])),
    sessionFactory: factory ?? { build: (scope, sessionId) => createMCPServer({ version: VERSION, scope, sessionId }) },
    ...limits,
  });
}

const initialize = (port: number, token = 'alice-token') => request(port, token, { method: 'POST', body: INITIALIZE });
const ping = async (port: number, sid: string) =>
  (await request(port, 'alice-token', { method: 'POST', sessionId: sid, body: PING(9) })).status;

/** Call a real tool over HTTP as the session's owner and return its structured result. */
async function callTool(port: number, sid: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await request(port, 'alice-token', {
    method: 'POST', sessionId: sid,
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } };
  expect(body.result?.isError ?? false).toBe(false);
  return body.result?.structuredContent ?? {};
}

async function expectCapacityRefusal(res: Response): Promise<void> {
  expect(res.status).toBe(503);
  expect(res.headers.get('mcp-session-id')).toBeNull();
  expect(res.headers.get('content-type')).toMatch(/application\/json/);
  const body = await res.json() as { error: string; message: string };
  expect(body.error).toBe('session-capacity');
  expect(body.message).toMatch(/No session was ended/);
}

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

/** A factory whose sessions hold every `ping` until `release()`; `held()` counts the ones waiting. */
function gatedPingFactory() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let held = 0;
  const factory: SessionFactory = {
    build: (scope, sessionId) => {
      const server = createMCPServer({ version: VERSION, scope, sessionId });
      const handle = server.handleMessage.bind(server);
      server.handleMessage = async (m) => {
        if ((m as { method?: string }).method === 'ping') { held++; await gate; }
        return handle(m);
      };
      return server;
    },
  };
  return { factory, held: () => held, release: () => release() };
}

/**
 * Session allowance for the HTTP transport (#6943). `initialize` is the only
 * request that creates a session and, before the cap, only `DELETE` removed
 * one, so a client that never ends its sessions grew the map (and the
 * MCPServer and layer workspace behind each entry) without limit.
 *
 * The contract: live sessions and pending builds both count against the cap;
 * at the cap a session is ended for a newcomer only if it is idle past the
 * window AND holds no unpublished layer drafts AND has no request in flight
 * AND no open SSE stream; otherwise the newcomer is refused.
 *
 * Only `Date` is faked, so idle time is stepped exactly while sockets and
 * timers run for real.
 */
describe('HttpTransport session cap (#6943)', () => {
  let transport: HttpTransport | undefined;
  const T0 = Date.UTC(2026, 0, 1);
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  /**
   * Gates to open and streams to abort before `close()`. A test that fails
   * while a request or a build is still held would otherwise leave `close()`
   * waiting on that connection.
   */
  const cleanups: Array<() => void> = [];

  async function start(limits: { maxSessions?: number; sessionIdleMs?: number }, factory?: SessionFactory): Promise<number> {
    transport = capped(limits, factory);
    await transport.listen();
    return transport.port() as number;
  }

  beforeEach(() => {
    resetLayerWorkspace();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0)) cleanup();
    await transport?.close();
    transport = undefined;
    resetLayerWorkspace();
  });

  it('refuses initialize with 503 session-capacity once maxSessions live sessions exist', async () => {
    const port = await start({ maxSessions: 3 });
    for (let i = 0; i < 3; i++) await initSession(port, 'alice-token');
    await expectCapacityRefusal(await initialize(port));
  });

  it('default cap is 1000: the 1001st initialize is refused (no option passed)', async () => {
    const port = await start({});
    for (let i = 0; i < 1000; i++) {
      const res = await initialize(port);
      if (res.status !== 200) throw new Error(`initialize ${i + 1} answered ${res.status}`);
    }
    expect((await initialize(port)).status).toBe(503);
  }, 60_000);

  it("the owner's DELETE frees the slot", async () => {
    const port = await start({ maxSessions: 1 });
    const sid = await initSession(port, 'alice-token');
    expect((await initialize(port)).status).toBe(503);
    await request(port, 'alice-token', { method: 'DELETE', sessionId: sid });
    expect((await initialize(port)).status).toBe(200);
  });

  describe('draft preservation', () => {
    it('at the cap, an idle session holding an unpublished draft is not ended: initialize gets session-capacity and the draft is still there', async () => {
      const port = await start({ maxSessions: 1, sessionIdleMs: IDLE });
      const owner = await initSession(port, 'alice-token');
      const created = await callTool(port, owner, 'create_draft_layer', { intent: 'unpublished work' });
      const draftId = created.draft_id as string;
      expect(getLayerWorkspace(owner).drafts.has(draftId)).toBe(true);

      advance(100 * IDLE);
      await expectCapacityRefusal(await initialize(port));
      await expectCapacityRefusal(await initialize(port, 'mallory-token'));

      expect(getLayerWorkspace(owner).drafts.has(draftId)).toBe(true);
      expect(getLayerWorkspace(owner).drafts.size).toBe(1);
      // The owner still has the session.
      expect(await ping(port, owner)).toBe(200);
    });

    it('a draft-holding session is passed over for a draft-free one, and is still not taken when it is the only idle one left', async () => {
      const port = await start({ maxSessions: 2, sessionIdleMs: IDLE });
      const withDraft = await initSession(port, 'alice-token');
      await callTool(port, withDraft, 'create_draft_layer', { intent: 'older, holds a draft' });
      advance(10);
      const bare = await initSession(port, 'alice-token');
      advance(2 * IDLE);

      const admitted = await initialize(port);
      expect(admitted.status).toBe(200);
      expect(await ping(port, bare)).toBe(404);
      expect(getLayerWorkspace(withDraft).drafts.size).toBe(1);

      // Now the only idle session is the one with a draft: nothing is safe to end.
      await expectCapacityRefusal(await initialize(port));
      expect(getLayerWorkspace(withDraft).drafts.size).toBe(1);
      expect(await ping(port, withDraft)).toBe(200);
    });

    it('once its owner publishes the draft, the same session becomes reclaimable after the idle window, and the published layer survives', async () => {
      const port = await start({ maxSessions: 1, sessionIdleMs: IDLE });
      const owner = await initSession(port, 'alice-token');
      const created = await callTool(port, owner, 'create_draft_layer', { intent: 'publish then leave' });
      advance(2 * IDLE);
      await expectCapacityRefusal(await initialize(port));

      const published = await callTool(port, owner, 'publish_layer', { draft_id: created.draft_id });
      expect(getLayerWorkspace(owner).drafts.size).toBe(0);
      // Publishing was a request: the idle window restarts from it.
      advance(IDLE - 1);
      await expectCapacityRefusal(await initialize(port));
      advance(1);
      expect((await initialize(port)).status).toBe(200);
      expect(await ping(port, owner)).toBe(404);
      expect(getLayerWorkspace().layers.has(published.layer_id as string)).toBe(true);
    });
  });

  describe('concurrency', () => {
    it('N concurrent initializes at cap-1 admit exactly one while their factories are pending', async () => {
      const d = deferredFactory();
      cleanups.push(d.release);
      const port = await start({ maxSessions: 3 }, d.factory);
      const first = [0, 1].map(() => initialize(port));
      while (d.pending() < 2) await sleep(5);
      d.release();
      await Promise.all(first);
      // Two live, cap 3: five at once, none has finished building yet.
      const burst = [0, 1, 2, 3, 4].map(() => initialize(port));
      while (d.pending() < 1) await sleep(5);
      await sleep(100);
      expect(d.pending()).toBe(1);
      d.release();
      expect((await Promise.all(burst)).map((r) => r.status).sort()).toEqual([200, 503, 503, 503, 503]);
    });

    it('a build still in flight counts against the cap: the next initialize is refused before the first has a session', async () => {
      const d = deferredFactory();
      cleanups.push(d.release);
      const port = await start({ maxSessions: 1 }, d.factory);
      const building = initialize(port);
      while (d.pending() < 1) await sleep(5);
      await expectCapacityRefusal(await initialize(port));
      expect(d.pending()).toBe(1);
      d.release();
      expect((await building).status).toBe(200);
    });

    it('a factory that throws, or returns the wrong session id, does not keep its slot', async () => {
      let call = 0;
      const port = await start({ maxSessions: 1 }, {
        build: (scope, sessionId) => {
          call++;
          if (call === 1) throw new Error('factory exploded');
          if (call === 2) return createMCPServer({ version: VERSION, scope, sessionId: 'not-the-id' });
          return createMCPServer({ version: VERSION, scope, sessionId });
        },
      });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect((await initialize(port)).status).toBe(500);
        expect((await initialize(port)).status).toBe(500);
      } finally {
        errSpy.mockRestore();
      }
      expect((await initialize(port)).status).toBe(200);
    });
  });

  describe('active requests and SSE streams', () => {
    it('a session with a request in flight is not reclaimed however stale; the idle window starts when the request settles', async () => {
      const g = gatedPingFactory();
      cleanups.push(g.release);
      const port = await start({ maxSessions: 1, sessionIdleMs: IDLE }, g.factory);
      const sid = await initSession(port, 'alice-token');
      const slow = request(port, 'alice-token', { method: 'POST', sessionId: sid, body: PING(2) });
      while (g.held() < 1) await sleep(5);
      advance(100 * IDLE);
      await expectCapacityRefusal(await initialize(port));
      g.release();
      expect((await slow).status).toBe(200);
      // Settled just now: it arrived 100 windows ago, but the session is not idle.
      await expectCapacityRefusal(await initialize(port));
      advance(IDLE - 1);
      await expectCapacityRefusal(await initialize(port));
      advance(1);
      expect((await initialize(port)).status).toBe(200);
      expect(await ping(port, sid)).toBe(404);
    });

    it('a session with an open GET SSE stream is not reclaimed however stale; the idle window starts when the stream closes', async () => {
      const port = await start({ maxSessions: 1, sessionIdleMs: IDLE });
      const sid = await initSession(port, 'alice-token');
      const ac = new AbortController();
      cleanups.push(() => ac.abort());
      const sse = await request(port, 'alice-token', {
        method: 'GET', sessionId: sid, headers: { Accept: 'text/event-stream' }, signal: ac.signal,
      });
      expect(sse.status).toBe(200);
      advance(100 * IDLE);
      await expectCapacityRefusal(await initialize(port));
      ac.abort();
      await sleep(150); // let the server observe the close
      await expectCapacityRefusal(await initialize(port));
      advance(IDLE - 1);
      await expectCapacityRefusal(await initialize(port));
      advance(1);
      expect((await initialize(port)).status).toBe(200);
      expect(await ping(port, sid)).toBe(404);
    });

    it('a session with an open POST SSE stream is not reclaimed however stale; the idle window starts when the stream closes', async () => {
      const port = await start({ maxSessions: 1, sessionIdleMs: IDLE });
      const sid = await initSession(port, 'alice-token');
      const ac = new AbortController();
      cleanups.push(() => ac.abort());
      const stream = await request(port, 'alice-token', {
        method: 'POST', sessionId: sid, body: PING(2), headers: { Accept: 'text/event-stream' }, signal: ac.signal,
      });
      expect(stream.status).toBe(200);
      const first = await (stream.body as ReadableStream<Uint8Array>).getReader().read();
      expect(new TextDecoder().decode(first.value)).toMatch(/^data: /);
      // The ping has been answered; only the open stream keeps the session.
      advance(100 * IDLE);
      await expectCapacityRefusal(await initialize(port));
      ac.abort();
      await sleep(150); // let the server observe the close
      await expectCapacityRefusal(await initialize(port));
      advance(IDLE - 1);
      await expectCapacityRefusal(await initialize(port));
      advance(1);
      expect((await initialize(port)).status).toBe(200);
      expect(await ping(port, sid)).toBe(404);
    });
  });

  describe('idle timing', () => {
    it('one millisecond under the window is not reclaimed; exactly at the window is', async () => {
      const port = await start({ maxSessions: 1, sessionIdleMs: IDLE });
      const sid = await initSession(port, 'alice-token');
      advance(IDLE - 1);
      await expectCapacityRefusal(await initialize(port));
      expect(await ping(port, sid)).toBe(200);
      // That ping restarted the window.
      advance(IDLE - 1);
      await expectCapacityRefusal(await initialize(port));
      advance(1);
      expect((await initialize(port)).status).toBe(200);
      expect(await ping(port, sid)).toBe(404);
    });

    it('frees one slot per initialize, oldest idle first, not every idle session', async () => {
      const port = await start({ maxSessions: 3, sessionIdleMs: IDLE });
      const a = await initSession(port, 'alice-token');
      advance(10);
      const b = await initSession(port, 'alice-token');
      advance(10);
      const c = await initSession(port, 'alice-token');
      // a, b and c were last seen at 0, 10 and 20; nothing touches b or c again
      // until the final assertions, so their survival is not owed to a refresh.
      advance(2 * IDLE);
      expect((await initialize(port)).status).toBe(200);
      expect(await ping(port, a)).toBe(404);
      expect(await ping(port, b)).toBe(200);
      expect(await ping(port, c)).toBe(200);
    });

    it("a request refused for scope mismatch does not restart another principal's idle window", async () => {
      const port = await start({ maxSessions: 1, sessionIdleMs: IDLE });
      const sid = await initSession(port, 'alice-token');
      advance(IDLE);
      const probe = await request(port, 'mallory-token', { method: 'POST', sessionId: sid, body: PING(2) });
      expect(probe.status).toBe(403);
      const sse = await request(port, 'mallory-token', { method: 'GET', sessionId: sid, headers: { Accept: 'text/event-stream' } });
      expect(sse.status).toBe(403);
      expect((await initialize(port)).status).toBe(200);
    });
  });

  describe('reconnect responses', () => {
    it('a client whose session was reclaimed gets 404 unknown-session on POST and on GET, 400 with no header, and can initialize again', async () => {
      const port = await start({ maxSessions: 1, sessionIdleMs: IDLE });
      const gone = await initSession(port, 'alice-token');
      advance(IDLE);
      const taker = await initSession(port, 'mallory-token');

      for (const init of [
        { method: 'POST', body: PING(2) },
        { method: 'GET', headers: { Accept: 'text/event-stream' } },
      ]) {
        const res = await request(port, 'alice-token', { ...init, sessionId: gone });
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
        const body = await res.json() as { error: string; message: string };
        expect(body.error).toBe('unknown-session');
        expect(body.message).toMatch(/idle/);
        expect(body.message).toMatch(/initialize/);
      }

      // No header at all is a client error, not a "session ended" signal.
      expect((await request(port, 'alice-token', { method: 'POST', body: PING(3) })).status).toBe(400);
      expect((await request(port, 'alice-token', { method: 'GET', headers: { Accept: 'text/event-stream' } })).status).toBe(400);

      // The slot is held by an active session, so reconnecting is refused, not granted at its expense.
      await expectCapacityRefusal(await initialize(port));
      expect((await request(port, 'mallory-token', { method: 'POST', sessionId: taker, body: PING(4) })).status).toBe(200);

      // Once a slot is free, a fresh initialize succeeds with a new session id.
      expect((await request(port, 'mallory-token', { method: 'DELETE', sessionId: taker })).status).toBe(204);
      const again = await initSession(port, 'alice-token');
      expect(again).not.toBe(gone);
      expect(await ping(port, again)).toBe(200);
    });

    it('a session ended by its owner with DELETE answers 404 unknown-session afterwards', async () => {
      const port = await start({ maxSessions: 2 });
      const sid = await initSession(port, 'alice-token');
      expect((await request(port, 'alice-token', { method: 'DELETE', sessionId: sid })).status).toBe(204);
      const res = await request(port, 'alice-token', { method: 'POST', sessionId: sid, body: PING(2) });
      expect(res.status).toBe(404);
      expect((await res.json() as { error: string }).error).toBe('unknown-session');
    });
  });
});
