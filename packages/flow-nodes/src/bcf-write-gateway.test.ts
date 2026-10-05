/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6896: BCF write nodes share the host's durable write path and never
// re-send a write whose earlier outcome is unknown.

import { describe, expect, it } from 'vitest';
import { parseCapabilities } from '@ifc-lite/extensions';
import { runFlow, type FlowDocument } from '@ifc-lite/flow';
import type { FetchTransport } from '@ifc-lite/sandbox';
import { createFakeBim } from './__tests__/fake-backend.js';
import { createStandardRegistry, headlessFeatures, type BcfWriteGateway, type BcfWriteIntent, type FlowHost } from './index.js';

const registry = createStandardRegistry();
const HOST = 'bcf.example.com';
const CONN = { baseUrl: `https://${HOST}/bcf`, projectId: 'P1', token: 'secret-token-123' };

function doc(type: string, params: Record<string, unknown>): FlowDocument {
  return { flowVersion: 1, id: 'g', name: 'g', capabilities: [`network.fetch:${HOST}`], inputs: [], outputs: [],
    nodes: [{ id: 'n', type, params: { ...CONN, ...params } }], edges: [] };
}

function run(d: FlowDocument, transport: FetchTransport, bcfWrites?: BcfWriteGateway) {
  const grants = parseCapabilities(d.capabilities);
  if (!grants.ok) throw new Error('bad grants');
  const host: FlowHost = { bim: createFakeBim().bim, networkGrants: grants.value, networkTransport: transport, ...(bcfWrites ? { bcfWrites } : {}) };
  return runFlow(d, { host, registry, features: headlessFeatures() });
}

/** Counts every write that reaches the network; answers creates with a fresh guid. */
function server(mode: 'ok' | 'drop' = 'ok') {
  const posts: string[] = [];
  const transport: FetchTransport = async (url, init) => {
    if (init.method === 'POST') posts.push(url.pathname);
    if (mode === 'drop') throw new TypeError('socket hang up');
    return new Response(JSON.stringify({ guid: `G${posts.length}`, title: 'x', comment: 'c' }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  return { transport, posts };
}

describe('bcf write nodes and the host write gateway (#6896)', () => {
  it('routes createTopic and addComment through the gateway with the exact payload and no token', async () => {
    const intents: BcfWriteIntent[] = [];
    const gateway: BcfWriteGateway = { write: async (intent, send) => { intents.push(intent); return send(); } };
    const net = server();
    const created = await run(doc('bcf.createTopic', { title: 'Duct hits beam', status: 'Open' }), net.transport, gateway);
    expect(created.ok).toBe(true);
    const commented = await run(doc('bcf.addComment', { topicGuid: 'T-9', comment: 'Checked on site' }), net.transport, gateway);
    expect(commented.ok).toBe(true);
    expect(intents).toEqual([
      { nodeType: 'bcf.createTopic', operation: 'createTopic', baseUrl: CONN.baseUrl, version: '2.1', projectId: 'P1',
        payload: { title: 'Duct hits beam', topic_status: 'Open' } },
      { nodeType: 'bcf.addComment', operation: 'createComment', baseUrl: CONN.baseUrl, version: '2.1', projectId: 'P1',
        topicGuid: 'T-9', payload: { comment: 'Checked on site' } },
    ]);
    expect(JSON.stringify(intents)).not.toContain(CONN.token);
    expect(net.posts).toHaveLength(2);
  });

  it('a gateway refusal (unresolved earlier write) sends nothing and fails the node with its reason', async () => {
    const gateway: BcfWriteGateway = { write: async () => { throw new Error('earlier identical write has an unknown outcome'); } };
    const net = server();
    const result = await run(doc('bcf.createTopic', { title: 'Duct hits beam' }), net.transport, gateway);
    expect(result.ok).toBe(false);
    expect(result.reports.find((r) => r.nodeId === 'n')?.error).toContain('unknown outcome');
    expect(net.posts).toHaveLength(0);
  });

  it('without a gateway a lost connection is reported as an unknown outcome and never retried', async () => {
    const net = server('drop');
    const result = await run(doc('bcf.createTopic', { title: 'Duct hits beam' }), net.transport);
    expect(result.ok).toBe(false);
    expect(result.reports.find((r) => r.nodeId === 'n')?.error).toMatch(/outcome unknown.*Check the project before running this node again/);
    expect(net.posts).toHaveLength(1);
  });
});
