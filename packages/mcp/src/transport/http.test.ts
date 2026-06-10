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

function makeTransport(factory?: SessionFactory): HttpTransport {
  return new HttpTransport({
    port: 0,
    host: '127.0.0.1',
    authenticator: new BearerTokenAuth(new Map([
      ['alice-token', ALICE],
      ['mallory-token', MALLORY],
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
  init: RequestInit & { sessionId?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(init.sessionId !== undefined ? { 'Mcp-Session-Id': init.sessionId } : {}),
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
      headers: { Authorization: 'Bearer mallory-token', Accept: 'text/event-stream' },
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
