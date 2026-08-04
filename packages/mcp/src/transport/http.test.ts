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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  init: RequestInit & { sessionId?: string; headers?: Record<string, string> } = {},
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
