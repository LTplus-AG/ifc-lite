/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `aps.token` / `aps.modelProperties` — receive Autodesk Platform Services
 * (APS) model data into a flow graph (#5634), so Revit/ACC properties can be
 * joined to an IFC model with `table.joinByKey`.
 *
 * Model Derivative is the read path, not Data Exchange: it is the path the
 * author's ifc-ai-rendering project runs successfully against live APS for
 * any translated Docs/ACC version, while its Data Exchange route needed
 * region/URN-format fallbacks and hard-coded exchange ids to find anything.
 *
 * Credentials: either chain `aps.token` into `token`, or set the credential
 * params on `aps.modelProperties` itself. The token is an opaque
 * {@link ApsToken} handle (see `aps-client.ts`), never a string, so neither
 * shape can print it. All I/O is `coreNetworkRequest` behind the graph's
 * `network.fetch:developer.api.autodesk.com` grant.
 */

import {
  APS_DEFAULT_SCOPE, APS_REGIONS, ApsToken, apsGet, delay, providedToken, requestClientToken, toDerivativeUrn,
} from './aps-client.js';
import { propertiesToTable } from './aps-table.js';
import { ANY_ITEM, SCALAR_ITEM, TABLE_ITEM, type Ctx, type FlowNodeDef } from './host.js';
import type { ParamDef } from '@ifc-lite/flow';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_RETRY_DELAY_MS = 5_000;

const CREDENTIAL_PARAMS: ParamDef[] = [
  { name: 'clientId', kind: 'string', default: '', doc: 'APS app client id, e.g. {{secret:APS_CLIENT_ID}}. With clientSecret, mints a 2-legged token.' },
  { name: 'clientSecret', kind: 'string', default: '', doc: 'APS app client secret: use {{secret:APS_CLIENT_SECRET}}, never a literal.' },
  { name: 'scope', kind: 'string', default: APS_DEFAULT_SCOPE, doc: 'OAuth scopes for the 2-legged token.' },
  { name: 'accessToken', kind: 'string', default: '', doc: 'A ready (e.g. 3-legged) access token, {{secret:APS_TOKEN}}. Wins over clientId/clientSecret.' },
];

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function bounded(value: unknown, fallback: number, min: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= min ? n : fallback;
}

async function tokenFromParams(ctx: Ctx, node: string, p: Readonly<Record<string, unknown>>): Promise<ApsToken> {
  const accessToken = str(p.accessToken);
  if (accessToken) return providedToken(accessToken);
  const clientId = str(p.clientId);
  const clientSecret = str(p.clientSecret);
  if (!clientId || !clientSecret) {
    throw new Error(`${node}: no credentials — set accessToken, or clientId and clientSecret (e.g. {{secret:APS_CLIENT_ID}} / {{secret:APS_CLIENT_SECRET}})`);
  }
  return requestClientToken(ctx, node, clientId, clientSecret, str(p.scope) || APS_DEFAULT_SCOPE);
}

async function resolveToken(ctx: Ctx, node: string, input: unknown, p: Readonly<Record<string, unknown>>): Promise<ApsToken> {
  if (input instanceof ApsToken) return input;
  if (input !== undefined && input !== null) {
    throw new Error(`${node}: "token" input is not an aps.token handle (a token cannot be passed as text or through a serialised value)`);
  }
  return tokenFromParams(ctx, node, p);
}

interface Retry {
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
}

/**
 * GET a Model Derivative resource, waiting out `202 Accepted` (APS is still
 * extracting the property database) for at most `maxAttempts` requests.
 */
async function getJson(
  ctx: Ctx, node: string, token: ApsToken, path: string, region: string, limits: { timeoutMs: number; maxBytes: number }, retry: Retry, what: string,
): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const res = await apsGet(ctx, node, token, path, { region, ...limits });
    if (res.status === 202) {
      if (attempt >= retry.maxAttempts) {
        throw new Error(`${node}: ${what} still processing on APS after ${attempt} attempt(s) (HTTP 202); the derivative is being extracted — re-run later or raise maxAttempts/retryDelayMs`);
      }
      ctx.log('info', `${what}: APS is still processing (HTTP 202), retry ${attempt}/${retry.maxAttempts - 1} in ${retry.retryDelayMs} ms`);
      await delay(retry.retryDelayMs, ctx.signal);
      continue;
    }
    if (res.status >= 200 && res.status < 300) {
      try {
        return JSON.parse(res.body) as unknown;
      } catch {
        throw new Error(`${node}: ${what} returned a non-JSON body`);
      }
    }
    throw new Error(`${node}: ${what} failed — ${describeStatus(res.status)} ${res.body.replace(/\s+/g, ' ').slice(0, 300)}`.trim());
  }
}

function describeStatus(status: number): string {
  if (status === 401 || status === 403) {
    return `not authorised (HTTP ${status}): the token lacks data:read/viewables:read, or a 2-legged app is not provisioned for this ACC/BIM 360 hub (use a 3-legged accessToken).`;
  }
  if (status === 404) return 'not found (HTTP 404): the URN has no derivatives (not translated yet, wrong region, or wrong URN).';
  if (status === 413) return 'too large (HTTP 413): set forceget to true.';
  return `HTTP ${status}:`;
}

interface MetadataView {
  readonly guid: string;
  readonly name?: string;
  readonly role?: string;
  readonly isMasterView?: boolean;
}

function pickView(metadata: unknown, requested: string): MetadataView {
  const list = (metadata as { data?: { metadata?: unknown } })?.data?.metadata;
  const views = (Array.isArray(list) ? list : []).filter((v): v is MetadataView => !!v && typeof (v as MetadataView).guid === 'string');
  if (requested) {
    const hit = views.find((v) => v.guid === requested);
    if (!hit) throw new Error(`view "${requested}" is not in this model's metadata (views: ${views.map((v) => `${v.guid} ${v.name ?? ''} [${v.role ?? '?'}]`).join(', ') || 'none'})`);
    return hit;
  }
  const threeD = views.filter((v) => v.role === '3d');
  const view = threeD.find((v) => v.isMasterView) ?? threeD[0];
  if (!view) throw new Error(`the model has no 3d view (views: ${views.map((v) => `${v.name ?? v.guid} [${v.role ?? '?'}]`).join(', ') || 'none'}); set viewGuid`);
  return view;
}

export const apsNodes: FlowNodeDef[] = [
  {
    type: 'aps.token',
    title: 'APS token',
    category: 'network',
    doc: 'An Autodesk Platform Services access token as an opaque handle for aps.* nodes: 2-legged from clientId/clientSecret, or a ready accessToken (3-legged). The token itself is never output, logged or serialised.',
    inputs: [],
    outputs: [{ name: 'token', type: ANY_ITEM }],
    params: CREDENTIAL_PARAMS,
    capabilities: ['network.fetch:*'],
    requires: { network: true },
    volatile: true,
    run: async (ctx, _i, p) => ({ token: await tokenFromParams(ctx, 'aps.token', p) }),
  },
  {
    type: 'aps.modelProperties',
    title: 'APS model properties',
    category: 'network',
    doc: 'Reads Model Derivative metadata and properties of a translated model (base64 derivative URN, or a Docs/ACC version id) into a table: objectid, externalId (Revit UniqueId), name, category, IfcGUID and every property as a Group.Property column. Joinable with IFC via table.joinByKey.',
    inputs: [
      { name: 'token', type: ANY_ITEM, optional: true, doc: 'From aps.token; otherwise the credential params are used.' },
      { name: 'urn', type: SCALAR_ITEM, optional: true, doc: 'Overrides the urn param.' },
    ],
    outputs: [
      { name: 'table', type: TABLE_ITEM },
      { name: 'view', type: SCALAR_ITEM },
    ],
    params: [
      { name: 'urn', kind: 'string', default: '', doc: 'Base64 derivative URN, or a urn:adsk.wipprod:fs.file:vf.…?version=N version id (encoded for you).' },
      { name: 'viewGuid', kind: 'string', default: '', doc: 'Metadata view guid; defaults to the master (else first) 3d view.' },
      { name: 'region', kind: 'enum', default: 'US', options: [...APS_REGIONS], doc: 'Data centre, sent as x-ads-region.' },
      { name: 'key', kind: 'string', default: 'externalId', doc: 'Key column of the output table, e.g. externalId, IfcGUID or objectid.' },
      { name: 'forceget', kind: 'boolean', default: false, doc: 'Ask APS for a property payload over its 20 MB default (answers HTTP 413 otherwise).' },
      { name: 'maxAttempts', kind: 'number', default: DEFAULT_MAX_ATTEMPTS, doc: 'Requests per resource while APS answers 202 (still processing).' },
      { name: 'retryDelayMs', kind: 'number', default: DEFAULT_RETRY_DELAY_MS },
      { name: 'timeoutMs', kind: 'number', default: DEFAULT_TIMEOUT_MS },
      { name: 'maxBytes', kind: 'number', default: DEFAULT_MAX_BYTES, doc: 'Response size cap per request.' },
      ...CREDENTIAL_PARAMS,
    ],
    capabilities: ['network.fetch:*'],
    requires: { network: true },
    volatile: true,
    run: async (ctx, i, p) => {
      const node = 'aps.modelProperties';
      const rawUrn = str(i.urn) || str(p.urn);
      let urn: string;
      try {
        urn = toDerivativeUrn(rawUrn);
      } catch (err) {
        throw new Error(`${node}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const region = (APS_REGIONS as readonly string[]).includes(str(p.region).toUpperCase()) ? str(p.region).toUpperCase() : 'US';
      const limits = { timeoutMs: bounded(p.timeoutMs, DEFAULT_TIMEOUT_MS, 1), maxBytes: bounded(p.maxBytes, DEFAULT_MAX_BYTES, 1) };
      const retry: Retry = {
        maxAttempts: Math.floor(bounded(p.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1)),
        retryDelayMs: bounded(p.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 0),
      };
      const token = await resolveToken(ctx, node, i.token, p);

      const base = `/modelderivative/v2/designdata/${urn}/metadata`;
      const metadata = await getJson(ctx, node, token, base, region, limits, retry, 'metadata');
      let view: MetadataView;
      try {
        view = pickView(metadata, str(p.viewGuid));
      } catch (err) {
        throw new Error(`${node}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const query = p.forceget === true ? '?forceget=true' : '';
      const props = await getJson(ctx, node, token, `${base}/${encodeURIComponent(view.guid)}/properties${query}`, region, limits, retry, 'properties');
      const collection = (props as { data?: { collection?: unknown } })?.data?.collection;
      if (!Array.isArray(collection)) throw new Error(`${node}: properties response has no data.collection`);
      try {
        return { table: propertiesToTable(collection, str(p.key) || 'externalId'), view: view.guid };
      } catch (err) {
        throw new Error(`${node}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
];
