/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// BCF API flow nodes (#5167 phase 3.4, #5634). Every test enters through
// `createStandardRegistry()` and a real `runFlow`, and plays the BCF server
// through `FlowHost.networkTransport`, so the gated `coreNetworkRequest`
// (https-only, exact-host grant) runs for every request exactly as in the
// CLI/MCP/viewer.

import { describe, expect, it } from 'vitest';
import { parseCapabilities } from '@ifc-lite/extensions';
import { MemoCache, runFlow, type FlowDocument, type FlowEdge, type FlowNode, type Table } from '@ifc-lite/flow';
import type { FetchTransport } from '@ifc-lite/sandbox';
import { createFakeBim } from './__tests__/fake-backend.js';
import { createStandardRegistry, headlessFeatures, interpolateSecrets, resolveSecretValues, type FlowHost } from './index.js';

const registry = createStandardRegistry();

const HOST = 'bcf.example.com';
const BASE = `https://${HOST}/bcf`;
const TOKEN = 'tok-abcdef-123456';
const CONN = { baseUrl: BASE, projectId: 'P1', token: TOKEN };

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: unknown;
}

const TOPICS = [
  {
    guid: 'T-1', title: 'Clash at grid A/3', topic_status: 'Open', topic_type: 'Clash', priority: 'High',
    assigned_to: 'alice@example.com', creation_date: '2026-01-02T10:00:00Z', modified_date: '2026-01-03T10:00:00Z',
    labels: ['Structure', 'MEP'], description: 'Duct hits beam',
  },
  { guid: 'T-2', title: 'Missing fire rating', topic_status: 'Closed' },
];

/** A fake BCF API server behind the flow host's transport; records every request it receives. */
function fakeBcfServer(opts: { failCreateAfter?: number } = {}) {
  const requests: Recorded[] = [];
  let created = 0;
  const transport: FetchTransport = async (url, init) => {
    const headers = new Headers(init.headers);
    const raw = typeof init.body === 'string' ? init.body : undefined;
    const body: unknown = raw === undefined ? undefined : JSON.parse(raw);
    requests.push({ method: String(init.method), url: url.toString(), authorization: headers.get('authorization'), contentType: headers.get('content-type'), body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    const path = url.pathname;
    if (init.method === 'GET' && /^\/bcf\/2\.1\/projects\/[^/]+\/topics$/.test(path)) return json(TOPICS);
    if (init.method === 'POST' && /^\/bcf\/2\.1\/projects\/[^/]+\/topics$/.test(path)) {
      if (opts.failCreateAfter !== undefined && created >= opts.failCreateAfter) return json({ message: 'quota exceeded' }, 400);
      created += 1;
      return json({ guid: `NEW-${created}`, ...(body as object) }, 201);
    }
    const comment = /^\/bcf\/2\.1\/projects\/[^/]+\/topics\/([^/]+)\/comments$/.exec(path);
    if (init.method === 'POST' && comment) return json({ guid: `C-${comment[1]}`, topic_guid: comment[1], ...(body as object) }, 201);
    return json({ message: `no route ${init.method} ${path}` }, 404);
  };
  return { transport, requests };
}

function doc(nodes: FlowNode[], edges: FlowEdge[] = [], capabilities: string[] = [`network.fetch:${HOST}`]): FlowDocument {
  return { flowVersion: 1, id: 'bcf', name: 'bcf', capabilities, inputs: [], outputs: [], nodes, edges };
}

function grantsOf(d: FlowDocument) {
  const r = parseCapabilities(d.capabilities);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; '));
  return r.value;
}

/** Runs `d` the way the CLI/MCP do: networkGrants are the graph's own declared capabilities. */
function run(d: FlowDocument, transport: FetchTransport, cache?: MemoCache) {
  const host: FlowHost = { bim: createFakeBim().bim, networkGrants: grantsOf(d), networkTransport: transport };
  return runFlow(d, { host, registry, features: headlessFeatures(), cache });
}

const edge = (from: string, fp: string, to: string, tp: string): FlowEdge => ({ from: [from, fp], to: [to, tp] });

function errorOf(r: Awaited<ReturnType<typeof runFlow>>, nodeId: string): string | undefined {
  return r.reports.find((x) => x.nodeId === nodeId)?.error;
}

describe('bcf.listTopics', () => {
  it('GETs the project topics with the OData query and bearer token, and tabulates them', async () => {
    const server = fakeBcfServer();
    const d = doc([{ id: 'list', type: 'bcf.listTopics', params: { ...CONN, filter: "topic_status eq 'Open'", top: 50 } }]);
    const r = await run(d, server.transport);
    expect(r.ok).toBe(true);

    expect(server.requests).toHaveLength(1);
    const [req] = server.requests;
    expect(req.method).toBe('GET');
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe(`${BASE}/2.1/projects/P1/topics`);
    expect(url.searchParams.get('$filter')).toBe("topic_status eq 'Open'");
    expect(url.searchParams.get('$top')).toBe('50');
    expect(req.authorization).toBe(`Bearer ${TOKEN}`);

    const out = r.outputs.get('list');
    expect(out?.get('count')).toEqual({ kind: 'item', value: 2 });
    expect(out?.get('topics')).toEqual({ kind: 'list', items: TOPICS });
    const table = out?.get('table');
    if (table?.kind !== 'item') throw new Error('expected a table item');
    const t = table.value as Table;
    expect(t.key).toBe('guid');
    expect(t.rows).toEqual([
      {
        guid: 'T-1', title: 'Clash at grid A/3', status: 'Open', type: 'Clash', priority: 'High', assigned_to: 'alice@example.com',
        creation_date: '2026-01-02T10:00:00Z', modified_date: '2026-01-03T10:00:00Z', labels: 'Structure;MEP', description: 'Duct hits beam',
      },
      {
        guid: 'T-2', title: 'Missing fire rating', status: 'Closed', type: null, priority: null, assigned_to: null,
        creation_date: null, modified_date: null, labels: null, description: null,
      },
    ]);
  });

  it('takes the token from a {{secret:NAME}} reference resolved the way the CLI/MCP runner does', async () => {
    const server = fakeBcfServer();
    const d = doc(
      [{ id: 'list', type: 'bcf.listTopics', params: { ...CONN, token: '{{secret:BCF_TOKEN}}' } }],
      [],
      [`network.fetch:${HOST}`, 'secret.read:BCF_TOKEN'],
    );
    const resolved = interpolateSecrets(d, resolveSecretValues(d, { BCF_TOKEN: TOKEN }));
    const r = await run(resolved, server.transport);
    expect(r.ok).toBe(true);
    expect(server.requests.map((q) => q.authorization)).toEqual([`Bearer ${TOKEN}`]);
    // The token is a request header only: nothing the run logs carries it.
    expect(JSON.stringify(r.log)).not.toContain(TOKEN);
  });

  it('sends no Authorization header for an anonymous server (empty token)', async () => {
    const server = fakeBcfServer();
    const r = await run(doc([{ id: 'list', type: 'bcf.listTopics', params: { ...CONN, token: '' } }]), server.transport);
    expect(r.ok).toBe(true);
    expect(server.requests.map((q) => q.authorization)).toEqual([null]);
  });

  it('surfaces a server error as the node error', async () => {
    const server = fakeBcfServer();
    const r = await run(doc([{ id: 'list', type: 'bcf.listTopics', params: { ...CONN, baseUrl: `https://${HOST}/nope` } }]), server.transport);
    expect(r.ok).toBe(false);
    expect(errorOf(r, 'list')).toMatch(/no route GET \/nope\/2\.1\/projects\/P1\/topics/);
  });
});

describe('bcf.createTopic', () => {
  it('POSTs one topic built from the params and outputs its guid', async () => {
    const server = fakeBcfServer();
    const d = doc([{
      id: 'create', type: 'bcf.createTopic',
      params: { ...CONN, title: 'Check door widths', description: 'Level 2', type: 'Issue', status: 'Open', priority: 'Normal', assignedTo: 'bob@example.com', labels: 'Doors; Accessibility' },
    }]);
    const r = await run(d, server.transport);
    expect(r.ok).toBe(true);
    expect(server.requests).toEqual([{
      method: 'POST',
      url: `${BASE}/2.1/projects/P1/topics`,
      authorization: `Bearer ${TOKEN}`,
      contentType: 'application/json',
      body: { title: 'Check door widths', description: 'Level 2', topic_type: 'Issue', topic_status: 'Open', priority: 'Normal', assigned_to: 'bob@example.com', labels: ['Doors', 'Accessibility'] },
    }]);
    expect(r.outputs.get('create')?.get('guids')).toEqual({ kind: 'list', items: ['NEW-1'] });
  });

  it('creates one topic per table row, cells overriding the params', async () => {
    const server = fakeBcfServer();
    const csv = 'title,status,labels\nWall too thin,,Walls;Structure\nSlab edge,Closed,\n';
    const d = doc(
      [
        { id: 'csv', type: 'core.string', params: { value: csv } },
        { id: 'read', type: 'table.readCsv' },
        { id: 'create', type: 'bcf.createTopic', params: { ...CONN, status: 'Open', type: 'Issue' } },
      ],
      [edge('csv', 'value', 'read', 'text'), edge('read', 'table', 'create', 'rows')],
    );
    const r = await run(d, server.transport);
    expect(r.ok).toBe(true);
    expect(server.requests.map((q) => [q.method, q.url, q.body])).toEqual([
      ['POST', `${BASE}/2.1/projects/P1/topics`, { title: 'Wall too thin', topic_type: 'Issue', topic_status: 'Open', labels: ['Walls', 'Structure'] }],
      ['POST', `${BASE}/2.1/projects/P1/topics`, { title: 'Slab edge', topic_type: 'Issue', topic_status: 'Closed' }],
    ]);
    expect(r.outputs.get('create')?.get('guids')).toEqual({ kind: 'list', items: ['NEW-1', 'NEW-2'] });
  });

  it('copies listed topics into another project (listTopics table → createTopic rows)', async () => {
    const server = fakeBcfServer();
    const d = doc(
      [
        { id: 'list', type: 'bcf.listTopics', params: CONN },
        { id: 'create', type: 'bcf.createTopic', params: { ...CONN, projectId: 'P2' } },
      ],
      [edge('list', 'table', 'create', 'rows')],
    );
    const r = await run(d, server.transport);
    expect(r.ok).toBe(true);
    expect(server.requests.map((q) => `${q.method} ${new URL(q.url).pathname}`)).toEqual([
      'GET /bcf/2.1/projects/P1/topics',
      'POST /bcf/2.1/projects/P2/topics',
      'POST /bcf/2.1/projects/P2/topics',
    ]);
    expect(server.requests[1].body).toEqual({
      title: 'Clash at grid A/3', description: 'Duct hits beam', topic_type: 'Clash', topic_status: 'Open', priority: 'High',
      assigned_to: 'alice@example.com', labels: ['Structure', 'MEP'],
    });
  });

  it('validates every row before sending anything: a titleless row fails the node with zero requests', async () => {
    const server = fakeBcfServer();
    const d = doc(
      [
        { id: 'csv', type: 'core.string', params: { value: 'title,priority\nFirst,High\n,Low\n' } },
        { id: 'read', type: 'table.readCsv' },
        { id: 'create', type: 'bcf.createTopic', params: CONN },
      ],
      [edge('csv', 'value', 'read', 'text'), edge('read', 'table', 'create', 'rows')],
    );
    const r = await run(d, server.transport);
    expect(r.ok).toBe(false);
    expect(errorOf(r, 'create')).toMatch(/row 2 has no title/);
    expect(server.requests).toEqual([]);
  });

  it('names the topics already created when a later row fails', async () => {
    const server = fakeBcfServer({ failCreateAfter: 1 });
    const d = doc(
      [
        { id: 'csv', type: 'core.string', params: { value: 'title\nA\nB\n' } },
        { id: 'read', type: 'table.readCsv' },
        { id: 'create', type: 'bcf.createTopic', params: CONN },
      ],
      [edge('csv', 'value', 'read', 'text'), edge('read', 'table', 'create', 'rows')],
    );
    const r = await run(d, server.transport);
    expect(r.ok).toBe(false);
    expect(errorOf(r, 'create')).toMatch(/failed after creating 1 topic\(s\) \[NEW-1\]: quota exceeded/);
  });
});

describe('bcf.addComment', () => {
  it('POSTs a comment to the topic from the params', async () => {
    const server = fakeBcfServer();
    const d = doc([{ id: 'c', type: 'bcf.addComment', params: { ...CONN, topicGuid: 'T-1', comment: 'Fixed in rev B', replyToCommentGuid: 'C-0' } }]);
    const r = await run(d, server.transport);
    expect(r.ok).toBe(true);
    expect(server.requests).toEqual([{
      method: 'POST',
      url: `${BASE}/2.1/projects/P1/topics/T-1/comments`,
      authorization: `Bearer ${TOKEN}`,
      contentType: 'application/json',
      body: { comment: 'Fixed in rev B', reply_to_comment_guid: 'C-0' },
    }]);
    expect(r.outputs.get('c')?.get('guid')).toEqual({ kind: 'item', value: 'C-T-1' });
  });

  it('comments on every topic createTopic made when wired from its guids', async () => {
    const server = fakeBcfServer();
    const d = doc(
      [
        { id: 'csv', type: 'core.string', params: { value: 'title\nA\nB\n' } },
        { id: 'read', type: 'table.readCsv' },
        { id: 'create', type: 'bcf.createTopic', params: CONN },
        { id: 'c', type: 'bcf.addComment', params: { ...CONN, comment: 'Raised by flow' } },
      ],
      [edge('csv', 'value', 'read', 'text'), edge('read', 'table', 'create', 'rows'), edge('create', 'guids', 'c', 'topicGuid')],
    );
    const r = await run(d, server.transport);
    expect(r.ok).toBe(true);
    expect(server.requests.filter((q) => q.url.endsWith('/comments')).map((q) => [q.url, q.body])).toEqual([
      [`${BASE}/2.1/projects/P1/topics/NEW-1/comments`, { comment: 'Raised by flow' }],
      [`${BASE}/2.1/projects/P1/topics/NEW-2/comments`, { comment: 'Raised by flow' }],
    ]);
  });
});

describe('bcf.* network gate', () => {
  const nodes: FlowNode[] = [
    { id: 'n', type: 'bcf.listTopics', params: CONN },
    { id: 'n', type: 'bcf.createTopic', params: { ...CONN, title: 'x' } },
    { id: 'n', type: 'bcf.addComment', params: { ...CONN, topicGuid: 'T-1', comment: 'x' } },
  ];

  it.each(nodes.map((n) => [n.type, n] as const))('%s refuses a host the graph did not grant, before the transport is called', async (_type, node) => {
    const server = fakeBcfServer();
    const r = await run(doc([node], [], ['network.fetch:other.example.com']), server.transport);
    expect(r.ok).toBe(false);
    expect(errorOf(r, 'n')).toMatch(new RegExp(`^${node.type.replace('.', '\\.')}: network\\.fetch refused: host "${HOST.replace(/\./g, '\\.')}"`));
    expect(server.requests).toEqual([]);
  });

  it.each(nodes.map((n) => [n.type, n] as const))('%s refuses a plain http: base URL even with the host granted', async (_type, node) => {
    const server = fakeBcfServer();
    const r = await run(doc([{ ...node, params: { ...node.params, baseUrl: `http://${HOST}/bcf` } }]), server.transport);
    expect(r.ok).toBe(false);
    expect(errorOf(r, 'n')).toMatch(/only https: URLs are permitted/);
    expect(server.requests).toEqual([]);
  });

  it.each(nodes.map((n) => [n.type, n] as const))('%s is never memoised: a rerun with identical params hits the server again', async (_type, node) => {
    const server = fakeBcfServer();
    const d = doc([node]);
    const cache = new MemoCache();
    const first = await run(d, server.transport, cache);
    const second = await run(d, server.transport, cache);
    expect(first.ok).toBe(true);
    expect(second.reports.find((x) => x.nodeId === 'n')?.status).toBe('ok');
    expect(server.requests).toHaveLength(2);
  });

  it('declares the network requirement and capability on every bcf node', () => {
    for (const type of ['bcf.listTopics', 'bcf.createTopic', 'bcf.addComment']) {
      const def = registry.get(type);
      expect(def?.requires?.network).toBe(true);
      expect(def?.capabilities).toEqual(['network.fetch:*']);
      expect(def?.volatile).toBe(true);
    }
  });
});
