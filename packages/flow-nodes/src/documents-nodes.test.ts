/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `documents.*` and `model.openFromSource` (#5634, #5167 phase 3.4), run
 * through `runFlow` against a fake OpenCDE Documents server injected as
 * the host's `networkTransport` — so every request still passes the real
 * `coreNetworkRequest` https/grant gate first.
 */

import { describe, expect, it } from 'vitest';
import { parseCapabilities } from '@ifc-lite/extensions';
import { MemoCache, nodeAvailability, runFlow, type FlowDocument, type FlowEdge, type FlowNode, type Table } from '@ifc-lite/flow';
import type { FetchTransport } from '@ifc-lite/sandbox';
import { createFakeBim } from './__tests__/fake-backend.js';
import { fromBase64 } from './base64.js';
import { BROWSER_FEATURES, createStandardRegistry, headlessFeatures, type FlowHost } from './index.js';

const registry = createStandardRegistry();
const BASE = 'https://cde.example/documents/1.0';
const DOWNLOAD = 'https://files.cde.example/dv/1/plan%20A.ifc';
const PAYLOAD = Uint8Array.from({ length: 700 }, (_, i) => (i * 37) % 256);

function doc(nodes: FlowNode[], edges: FlowEdge[] = []): FlowDocument {
  return { flowVersion: 1, id: 'g', name: 'g', capabilities: [], inputs: [], outputs: [], nodes, edges };
}

function grants(...raw: string[]) {
  const r = parseCapabilities(raw);
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; '));
  return r.value;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** A tiny Documents API: `/document-versions` honours If-None-Match; the download link serves `PAYLOAD`. */
function fakeServer(calls: Call[]): FetchTransport {
  return async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ url: url.href, method: String(init.method), headers, body: typeof init.body === 'string' ? init.body : undefined });
    if (url.href === `${BASE}/document-versions`) {
      if (headers['if-none-match'] === '"v1"') return new Response(null, { status: 304, headers: { ETag: '"v1"' } });
      const ids = (JSON.parse(String(init.body)) as { document_ids: string[] }).document_ids;
      const versions = ids.map((id, n) => ({
        document_id: id,
        version_number: 'B',
        version_index: n + 2,
        title: `Doc ${id}`,
        creation_date: '2026-09-01T00:00:00Z',
        file_description: { name: `${id}.ifc`, size_in_bytes: PAYLOAD.byteLength },
        links: {
          document_version: { url: `${BASE}/dv/${id}` },
          document_version_metadata: { url: `${BASE}/dv/${id}/metadata` },
          document_version_download: { url: DOWNLOAD },
          document_versions: { url: `${BASE}/documents/${id}/versions` },
        },
      }));
      return new Response(JSON.stringify({ versions }), { status: 200, headers: { 'Content-Type': 'application/json', ETag: '"v1"' } });
    }
    if (url.href === DOWNLOAD) return new Response(PAYLOAD, { status: 200, headers: { 'Content-Type': 'application/x-step' } });
    return new Response('not found', { status: 404 });
  };
}

function host(calls: Call[], extra: Partial<FlowHost> = {}): FlowHost {
  return {
    bim: createFakeBim().bim,
    networkGrants: grants('network.fetch:cde.example', 'network.fetch:files.cde.example'),
    networkTransport: fakeServer(calls),
    ...extra,
  };
}

const out = (r: Awaited<ReturnType<typeof runFlow>>, node: string, port: string) => {
  const data = r.outputs.get(node)?.get(port);
  if (data?.kind !== 'item') throw new Error(`${node}.${port}: expected an item, got ${JSON.stringify(data)}`);
  return data.value;
};

describe('documents.queryVersions', () => {
  it('round-trips the ETag: a first poll returns the versions and an ETag, a second poll with it reports unchanged', async () => {
    const calls: Call[] = [];
    const poll = (etag: string) => runFlow(doc([
      { id: 'q', type: 'documents.queryVersions', params: { baseUrl: BASE, documentIds: ['d1', 'd2'], etag, token: 'tok-123456' } },
    ]), { host: host(calls), registry, features: headlessFeatures() });

    const first = await poll('');
    expect(first.ok).toBe(true);
    expect(out(first, 'q', 'changed')).toBe(true);
    expect(out(first, 'q', 'etag')).toBe('"v1"');
    const table = out(first, 'q', 'versions') as Table;
    expect(table.rows.map((r) => [r.document_id, r.version_index, r.file_name, r.download_url])).toEqual([
      ['d1', 2, 'd1.ifc', DOWNLOAD],
      ['d2', 3, 'd2.ifc', DOWNLOAD],
    ]);
    expect(calls[0]).toMatchObject({ method: 'POST', body: JSON.stringify({ document_ids: ['d1', 'd2'] }) });
    expect(calls[0].headers.authorization).toBe('Bearer tok-123456');
    expect(calls[0].headers['if-none-match']).toBeUndefined();

    const second = await poll('"v1"');
    expect(second.ok).toBe(true);
    expect(calls[1].headers['if-none-match']).toBe('"v1"');
    expect(out(second, 'q', 'changed')).toBe(false);
    expect(out(second, 'q', 'etag')).toBe('"v1"');
    expect((out(second, 'q', 'versions') as Table).rows).toEqual([]);
  });

  it('refuses an ungranted CDE host before the transport is ever called', async () => {
    const calls: Call[] = [];
    const r = await runFlow(doc([
      { id: 'q', type: 'documents.queryVersions', params: { baseUrl: 'https://other.example/documents/1.0', documentIds: ['d1'] } },
    ]), { host: host(calls), registry, features: headlessFeatures() });
    expect(r.ok).toBe(false);
    expect(r.log.find((l) => l.level === 'error')?.message).toMatch(/other\.example.*not covered by a granted network\.fetch/);
    expect(calls).toEqual([]);
  });

  it('is never memoised: a rerun with a shared cache asks the server again', async () => {
    const calls: Call[] = [];
    const cache = new MemoCache();
    const d = doc([{ id: 'q', type: 'documents.queryVersions', params: { baseUrl: BASE, documentIds: ['d1'] } }]);
    await runFlow(d, { host: host(calls), registry, cache, features: headlessFeatures() });
    const again = await runFlow(d, { host: host(calls), registry, cache, features: headlessFeatures() });
    expect(again.reports.find((x) => x.nodeId === 'q')?.status).toBe('ok');
    expect(calls).toHaveLength(2);
  });
});

describe('documents.download', () => {
  it('downloads the version bytes intact, with name, size and content type', async () => {
    const calls: Call[] = [];
    const r = await runFlow(doc([
      { id: 'dl', type: 'documents.download', params: { url: DOWNLOAD, token: 'tok-123456' } },
    ]), { host: host(calls), registry, features: headlessFeatures() });
    expect(r.ok).toBe(true);
    expect(Array.from(fromBase64(String(out(r, 'dl', 'data'))))).toEqual(Array.from(PAYLOAD));
    expect(out(r, 'dl', 'size')).toBe(PAYLOAD.byteLength);
    expect(out(r, 'dl', 'name')).toBe('plan A.ifc');
    expect(out(r, 'dl', 'contentType')).toBe('application/x-step');
    expect(calls[0]).toMatchObject({ method: 'GET', url: DOWNLOAD });
    expect(calls[0].headers.authorization).toBe('Bearer tok-123456');
  });

  it('fails rather than yield a truncated file when the body exceeds maxBytes', async () => {
    const r = await runFlow(doc([
      { id: 'dl', type: 'documents.download', params: { url: DOWNLOAD, maxBytes: 100 } },
    ]), { host: host([]), registry, features: headlessFeatures() });
    expect(r.ok).toBe(false);
    expect(r.log.find((l) => l.level === 'error')?.message).toMatch(/exceeded maxBytes \(100\)/);
  });

  it('downloads every version a poll returned, via table.column', async () => {
    const calls: Call[] = [];
    const r = await runFlow(doc(
      [
        { id: 'q', type: 'documents.queryVersions', params: { baseUrl: BASE, documentIds: ['d1', 'd2'] } },
        { id: 'urls', type: 'table.column', params: { column: 'download_url' } },
        { id: 'names', type: 'table.column', params: { column: 'file_name' } },
        { id: 'dl', type: 'documents.download' },
      ],
      [
        { from: ['q', 'versions'], to: ['urls', 'table'] },
        { from: ['q', 'versions'], to: ['names', 'table'] },
        { from: ['urls', 'values'], to: ['dl', 'url'] },
        { from: ['names', 'values'], to: ['dl', 'name'] },
      ],
    ), { host: host(calls), registry, features: headlessFeatures() });
    expect(r.ok).toBe(true);
    expect(r.outputs.get('dl')?.get('name')).toEqual({ kind: 'list', items: ['d1.ifc', 'd2.ifc'] });
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/document-versions`, DOWNLOAD, DOWNLOAD]);
  });
});

describe('model.openFromSource', () => {
  it('hands the downloaded bytes to the host, and a model read wired to its modelId runs after it, on that model', async () => {
    const events: string[] = [];
    const fake = createFakeBim();
    const opened: Array<{ bytes: number[]; name: string }> = [];
    const h = host([], {
      bim: fake.bim,
      openModel: async (bytes, name) => {
        events.push('open');
        opened.push({ bytes: Array.from(bytes), name });
        return { modelId: 'm1' };
      },
    });
    const query = fake.bim.query.bind(fake.bim);
    Object.assign(fake.bim, { query: () => { events.push('query'); return query(); } });
    const r = await runFlow(doc(
      [
        // Listed first on purpose: only the edge can make it run after the open.
        { id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } },
        { id: 'dl', type: 'documents.download', params: { url: DOWNLOAD } },
        { id: 'open', type: 'model.openFromSource' },
      ],
      [
        { from: ['dl', 'data'], to: ['open', 'data'] },
        { from: ['dl', 'name'], to: ['open', 'name'] },
        { from: ['open', 'modelId'], to: ['walls', 'modelId'] },
      ],
    ), { host: h, registry, features: headlessFeatures() });
    expect(r.ok).toBe(true);
    expect(opened).toEqual([{ bytes: Array.from(PAYLOAD), name: 'plan A.ifc' }]);
    expect(out(r, 'open', 'modelId')).toBe('m1');
    expect(events).toEqual(['open', 'query']);
    const walls = r.outputs.get('walls')?.get('entities');
    expect(walls?.kind === 'list' ? walls.items.map((e) => (e as { globalId: string }).globalId) : null).toEqual(['W1', 'W2', 'W3']);
  });

  it('is unavailable on a host without the openModel backend feature, and available on the viewer and headless hosts', () => {
    const def = registry.get('model.openFromSource');
    const bare = { backend: new Set(['mutate', 'store']), network: true, secrets: new Set<string>() };
    expect(nodeAvailability(def, 'model.openFromSource', bare)).toEqual({
      status: 'unavailable',
      reasons: ['backend feature "openModel" is not available on this host'],
    });
    expect(nodeAvailability(def, 'model.openFromSource', BROWSER_FEATURES).status).toBe('ok');
    expect(nodeAvailability(def, 'model.openFromSource', headlessFeatures()).status).toBe('ok');
  });

  it('fails plainly when the host implements no openModel', async () => {
    const r = await runFlow(doc([
      { id: 's', type: 'core.string', params: { value: 'SVNPLTEwMzAzLTIx' } },
      { id: 'open', type: 'model.openFromSource' },
    ], [{ from: ['s', 'value'], to: ['open', 'data'] }]), { host: { bim: createFakeBim().bim }, registry });
    expect(r.ok).toBe(false);
    expect(r.log.find((l) => l.level === 'error')?.message).toBe('model.openFromSource: this host cannot open models');
  });
});
