/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `aps.token` / `aps.modelProperties` against a fake APS (#5634).
 *
 * Only the transport is substituted: the real nodes run through the real
 * `runFlow`, the real `coreNetworkRequest` grant check and the real secrets
 * interpolation/redaction the CLI and MCP use. The fake answers the three
 * endpoints ifc-ai-rendering calls on live APS (token, metadata, properties),
 * including the `202 Accepted` "still processing" answer.
 */

import { describe, expect, it } from 'vitest';
import { parseCapabilities } from '@ifc-lite/extensions';
import { runFlow, type FlowDocument, type FlowEdge, type FlowNode, type Table } from '@ifc-lite/flow';
import type { FetchTransport } from '@ifc-lite/sandbox';
import {
  buildRedactionMap, createStandardRegistry, headlessFeatures, interpolateSecrets, redactDeep, resolveSecretValues, validateSecretReferences,
} from './index.js';

const registry = createStandardRegistry();
const CLIENT_ID = 'client-id-7a6b5c4d3e2f';
const CLIENT_SECRET = 'client-secret-do-not-leak-0f1e2d3c';
const MINTED_TOKEN = 'eyJminted-access-token-never-printed-42';
const DERIVATIVE_URN = 'dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6YnVja2V0L2hvdXNlLnJ2dA';
const APS = 'https://developer.api.autodesk.com';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string | undefined;
}

const COLLECTION = [
  {
    objectid: 1, name: 'Basic Wall [185522]', externalId: 'a1b2c3d4-0001-4000-8000-000000000001-0002d4b2',
    properties: {
      __category__: { Category: 'Revit Walls' },
      Dimensions: { Length: 5.2, Area: '13.5 m^2' },
      'Identity Data': { Mark: 'W-01', Tag: 'T1' },
      'IFC Parameters': { IfcGUID: '2O2Fr$t4X7Zf8NOew3FLOH' },
    },
  },
  {
    objectid: 2, name: 'Door [185600]', externalId: 'a1b2c3d4-0001-4000-8000-000000000001-0002d500',
    properties: {
      Other: { Category: 'Doors' },
      Dimensions: { Length: 'n/a' },
      'Identity Data': { Mark: 'D-01' },
    },
  },
];

/** A fake APS: `processingReplies` properties calls answer 202 before the collection. */
function fakeAps(calls: Call[], opts: { processingReplies?: number; tokenStatus?: number } = {}): FetchTransport {
  let processing = opts.processingReplies ?? 0;
  return async (url, init) => {
    const body = typeof init.body === 'string' ? init.body : undefined;
    calls.push({ method: String(init.method), url: url.href, headers: new Headers(init.headers), body });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/authentication/v2/token') {
      if (opts.tokenStatus) return json(opts.tokenStatus, { developerMessage: 'The client_id specified does not have access to the api product' });
      return json(200, { access_token: MINTED_TOKEN, token_type: 'Bearer', expires_in: 3599 });
    }
    if (/\/metadata$/.test(url.pathname)) {
      return json(200, { data: { type: 'metadata', metadata: [
        { name: 'Sheet A101', role: '2d', guid: 'guid-2d' },
        { name: '{3D}', role: '3d', guid: 'guid-3d', isMasterView: true },
      ] } });
    }
    if (url.pathname.endsWith('/metadata/guid-3d/properties')) {
      if (processing > 0) {
        processing -= 1;
        return json(202, { result: 'success' });
      }
      return json(200, { data: { type: 'properties', collection: COLLECTION } });
    }
    return json(404, { diagnostic: `no route ${url.pathname}` });
  };
}

function grants(raw: readonly string[]) {
  const r = parseCapabilities(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

const edge = (from: string, fp: string, to: string, tp: string): FlowEdge => ({ from: [from, fp], to: [to, tp] });

function graph(nodes: FlowNode[], edges: FlowEdge[], outputs: FlowDocument['outputs'], capabilities: string[]): FlowDocument {
  return { flowVersion: 1, id: 'aps', name: 'aps', capabilities, inputs: [], outputs, nodes, edges };
}

const CAPS = ['network.fetch:developer.api.autodesk.com', 'secret.read:APS_CLIENT_ID', 'secret.read:APS_CLIENT_SECRET'];
const ENV = { APS_CLIENT_ID: CLIENT_ID, APS_CLIENT_SECRET: CLIENT_SECRET };

/** Interpolate secrets like `flow run` does, then run with the fake APS as transport. */
async function run(doc: FlowDocument, transport: FetchTransport, networkCaps: readonly string[] = doc.capabilities) {
  expect(validateSecretReferences(doc, ENV)).toEqual([]);
  const values = resolveSecretValues(doc, ENV);
  const result = await runFlow(interpolateSecrets(doc, values), {
    host: { bim: {} as never, networkGrants: grants(networkCaps.filter((c) => c.startsWith('network.'))), networkTransport: transport },
    registry,
    features: headlessFeatures(Object.keys(ENV)),
  });
  return { result, redaction: buildRedactionMap(values) };
}

const serialize = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Map ? Object.fromEntries(x) : x));

const chained = (props: Record<string, unknown>) => graph(
  [
    { id: 'tok', type: 'aps.token', params: { clientId: '{{secret:APS_CLIENT_ID}}', clientSecret: '{{secret:APS_CLIENT_SECRET}}' } },
    { id: 'props', type: 'aps.modelProperties', params: { urn: DERIVATIVE_URN, region: 'EMEA', retryDelayMs: 0, ...props } },
  ],
  [edge('tok', 'token', 'props', 'token')],
  [{ nodeId: 'props', port: 'table', label: 'table' }, { nodeId: 'tok', port: 'token', label: 'token' }],
  CAPS,
);

describe('aps.token → aps.modelProperties against a fake APS', () => {
  it('mints a 2-legged token with a form POST, waits out 202, and outputs one row per object', async () => {
    const calls: Call[] = [];
    const { result } = await run(chained({}), fakeAps(calls, { processingReplies: 2 }));
    expect(result.reports.filter((r) => r.error).map((r) => r.error)).toEqual([]);
    expect(result.ok).toBe(true);

    // Requests: one token POST, metadata, then properties until it stops answering 202.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${APS}/authentication/v2/token`,
      `GET ${APS}/modelderivative/v2/designdata/${DERIVATIVE_URN}/metadata`,
      `GET ${APS}/modelderivative/v2/designdata/${DERIVATIVE_URN}/metadata/guid-3d/properties`,
      `GET ${APS}/modelderivative/v2/designdata/${DERIVATIVE_URN}/metadata/guid-3d/properties`,
      `GET ${APS}/modelderivative/v2/designdata/${DERIVATIVE_URN}/metadata/guid-3d/properties`,
    ]);
    const tokenCall = calls[0];
    expect(tokenCall.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(tokenCall.headers.get('authorization')).toBeNull();
    expect(Object.fromEntries(new URLSearchParams(tokenCall.body))).toEqual({
      grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope: 'data:read viewables:read',
    });
    for (const c of calls.slice(1)) {
      expect(c.headers.get('authorization')).toBe(`Bearer ${MINTED_TOKEN}`);
      expect(c.headers.get('x-ads-region')).toBe('EMEA');
      expect(c.body).toBeUndefined();
    }

    const table = result.outputs.get('props')?.get('table');
    expect(table?.kind).toBe('item');
    const t = (table as { value: Table }).value;
    expect(t.key).toBe('externalId');
    expect(t.columns).toEqual([
      { name: 'objectid', type: 'integer' },
      { name: 'externalId', type: 'identifier' },
      { name: 'name', type: 'label' },
      { name: 'category', type: 'label' },
      { name: 'IfcGUID', type: 'identifier' },
      { name: '__category__.Category', type: 'string' },
      { name: 'Dimensions.Length', type: 'string' },
      { name: 'Dimensions.Area', type: 'string' },
      { name: 'Identity Data.Mark', type: 'string' },
      { name: 'Identity Data.Tag', type: 'string' },
      { name: 'IFC Parameters.IfcGUID', type: 'string' },
      { name: 'Other.Category', type: 'string' },
    ]);
    expect(t.rows).toEqual([
      {
        objectid: 1, externalId: COLLECTION[0].externalId, name: 'Basic Wall [185522]', category: 'Revit Walls', IfcGUID: '2O2Fr$t4X7Zf8NOew3FLOH',
        '__category__.Category': 'Revit Walls', 'Dimensions.Length': '5.2', 'Dimensions.Area': '13.5 m^2',
        'Identity Data.Mark': 'W-01', 'Identity Data.Tag': 'T1', 'IFC Parameters.IfcGUID': '2O2Fr$t4X7Zf8NOew3FLOH', 'Other.Category': null,
      },
      {
        objectid: 2, externalId: COLLECTION[1].externalId, name: 'Door [185600]', category: 'Doors', IfcGUID: null,
        '__category__.Category': null, 'Dimensions.Length': 'n/a', 'Dimensions.Area': null,
        'Identity Data.Mark': 'D-01', 'Identity Data.Tag': null, 'IFC Parameters.IfcGUID': null, 'Other.Category': 'Doors',
      },
    ]);
    expect(result.outputs.get('props')?.get('view')).toEqual({ kind: 'item', value: 'guid-3d' });
    expect(result.log.filter((l) => l.nodeId === 'props' && /HTTP 202/.test(l.message))).toHaveLength(2);
  });

  it('never lets the client secret or the minted token reach run output, even unredacted', async () => {
    const calls: Call[] = [];
    const { result, redaction } = await run(chained({}), fakeAps(calls));
    expect(result.ok).toBe(true);
    const summary = { outputs: result.graphOutputs, log: result.log, reports: result.reports, all: result.outputs };
    // The minted token is no secret the redaction map knows: only the opaque handle keeps it out.
    const raw = serialize(summary);
    expect(raw).not.toContain(MINTED_TOKEN);
    expect(raw).toContain('"kind":"aps.token"');
    const redacted = serialize(redactDeep(summary, redaction));
    expect(redacted).not.toContain(CLIENT_SECRET);
    expect(redacted).not.toContain(CLIENT_ID);
    expect(redacted).not.toContain(MINTED_TOKEN);
  });

  it('redacts the client secret from a failed token request', async () => {
    const calls: Call[] = [];
    const { result, redaction } = await run(chained({}), fakeAps(calls, { tokenStatus: 401 }));
    expect(result.ok).toBe(false);
    const err = result.reports.find((r) => r.nodeId === 'tok')?.error ?? '';
    expect(err).toMatch(/aps\.token: token request failed \(HTTP 401\)/);
    expect(serialize(redactDeep({ reports: result.reports, log: result.log }, redaction))).not.toContain(CLIENT_SECRET);
  });

  it('bounds the 202 wait: fails clearly after maxAttempts property requests', async () => {
    const calls: Call[] = [];
    const { result } = await run(chained({ maxAttempts: 3 }), fakeAps(calls, { processingReplies: 99 }));
    expect(result.ok).toBe(false);
    expect(calls.filter((c) => c.url.endsWith('/properties'))).toHaveLength(3);
    expect(result.reports.find((r) => r.nodeId === 'props')?.error).toMatch(/properties still processing on APS after 3 attempt\(s\) \(HTTP 202\)/);
  });

  it('refuses an ungranted host before the transport ever runs', async () => {
    const calls: Call[] = [];
    const { result } = await run(chained({}), fakeAps(calls), ['network.fetch:api.example.com']);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(result.reports.find((r) => r.nodeId === 'tok')?.error).toMatch(/aps\.token: network\.fetch refused: host "developer\.api\.autodesk\.com"/);
  });
});

describe('aps.modelProperties on its own', () => {
  const single = (params: Record<string, unknown>) => graph(
    [{ id: 'props', type: 'aps.modelProperties', params: { retryDelayMs: 0, ...params } }],
    [],
    [{ nodeId: 'props', port: 'table', label: 'table' }],
    ['network.fetch:developer.api.autodesk.com'],
  );

  it('encodes a Docs/ACC version id as an unpadded base64url URN and uses a provided token without minting one', async () => {
    const calls: Call[] = [];
    const versionId = 'urn:adsk.wipprod:fs.file:vf.Qv3iZt0mTYa1u8e_Ab-cDw?version=2';
    const { result } = await run(single({ urn: versionId, accessToken: MINTED_TOKEN, key: 'IfcGUID' }), fakeAps(calls));
    expect(result.ok).toBe(true);
    const expected = Buffer.from(versionId, 'utf8').toString('base64url');
    expect(expected).not.toMatch(/[=+/]/);
    expect(calls.map((c) => c.url)).toEqual([
      `${APS}/modelderivative/v2/designdata/${expected}/metadata`,
      `${APS}/modelderivative/v2/designdata/${expected}/metadata/guid-3d/properties`,
    ]);
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${MINTED_TOKEN}`);
    expect(calls[0].headers.get('x-ads-region')).toBe('US');
    expect(((result.outputs.get('props')?.get('table')) as { value: Table }).value.key).toBe('IfcGUID');
  });

  it('refuses an item (lineage) id with a hint, before any request', async () => {
    const calls: Call[] = [];
    const { result } = await run(single({ urn: 'urn:adsk.wipprod:dm.lineage:Qv3iZt0mTYa1u8e_Ab-cDw', accessToken: MINTED_TOKEN }), fakeAps(calls));
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(result.reports.find((r) => r.nodeId === 'props')?.error).toMatch(/item \(lineage\) id, not a version/);
  });

  it('fails without credentials instead of sending an unauthenticated request', async () => {
    const calls: Call[] = [];
    const { result } = await run(single({ urn: DERIVATIVE_URN }), fakeAps(calls));
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(result.reports.find((r) => r.nodeId === 'props')?.error).toMatch(/no credentials/);
  });

  it('declares network, volatility and the network.fetch capability on both nodes', () => {
    for (const type of ['aps.token', 'aps.modelProperties']) {
      const def = registry.get(type);
      expect(def?.requires?.network, type).toBe(true);
      expect(def?.volatile, type).toBe(true);
      expect(def?.capabilities, type).toEqual(['network.fetch:*']);
    }
  });
});
