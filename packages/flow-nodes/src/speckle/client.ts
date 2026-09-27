/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Speckle wire protocol, spoken ONLY through `coreNetworkRequest` (the
 * gated, https-only, exact-host-grant request function every flow node
 * uses). Nothing here calls `fetch`: the transport comes from the host, and
 * the grant check runs before any byte moves.
 *
 * Three requests, the same three Speckle's own object loader makes:
 *
 *   POST /graphql                               version → `referencedObject` (root object id)
 *   GET  /objects/<project>/<object>/single     the root object alone
 *   POST /api/getobjects/<project>              a batch of objects by id, one `id\tjson` per line
 *
 * The walk is lazy and iterative: a round fetches only the ids the previous
 * round referenced and has not yet seen, so display meshes and their data
 * chunks (the bulk of any commit) are never downloaded — `speckle.receive`
 * does not write them (see `mapping.ts`). A visited set stops cycles and
 * revisits, and `maxObjects` bounds the total, failing loudly when reached.
 */

import { coreNetworkRequest, NetworkDeniedError, type FetchTransport } from '@ifc-lite/sandbox';
import type { Capability } from '@ifc-lite/extensions';
import type { SpeckleTarget } from './url.js';

export type SpeckleObject = Readonly<Record<string, unknown>> & { readonly id: string };

export interface SpeckleClientOptions {
  readonly grants: readonly Capability[];
  readonly transport?: FetchTransport;
  /** Personal access token; sent as `Authorization: Bearer`. Empty = anonymous (public projects). */
  readonly token?: string;
  readonly timeoutMs: number;
  /** Per-response byte cap. A response that hits it fails the receive: a truncated batch is missing objects. */
  readonly maxBytes: number;
  /** Upper bound on the number of objects fetched. */
  readonly maxObjects: number;
  readonly signal?: AbortSignal;
}

/** Keys whose values are display geometry: never followed, never fetched. */
export const DISPLAY_KEYS: ReadonlySet<string> = new Set(['displayValue', '@displayValue', 'displayMesh', '@displayMesh']);

const BATCH_SIZE = 500;

function headers(opts: SpeckleClientOptions, extra: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (opts.token && opts.token.length > 0) h.Authorization = `Bearer ${opts.token}`;
  return h;
}

async function request(
  opts: SpeckleClientOptions, url: string, method: 'GET' | 'POST', extra: Record<string, string>, body?: string,
): Promise<string> {
  let res;
  try {
    res = await coreNetworkRequest(
      { url, method, headers: headers(opts, extra), body, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes, signal: opts.signal },
      opts.grants,
      opts.transport,
    );
  } catch (err) {
    if (err instanceof NetworkDeniedError) throw new Error(`speckle.receive: ${err.message}`);
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`speckle.receive: ${method} ${url} was refused (${res.status}); the project is private or the token lacks access`);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`speckle.receive: ${method} ${url} failed with status ${res.status}`);
  if (res.truncated) throw new Error(`speckle.receive: the response from ${url} exceeded maxBytes (${opts.maxBytes}); raise maxBytes to receive this model`);
  return res.body;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`speckle.receive: ${what} is not valid JSON`);
  }
}

const VERSION_QUERY = 'query ($projectId: String!, $versionId: String!) { project(id: $projectId) { version(id: $versionId) { id referencedObject } } }';
const LATEST_QUERY =
  'query ($projectId: String!, $modelId: String!) { project(id: $projectId) { model(id: $modelId) { versions(limit: 1) { items { id referencedObject } } } } }';

/** The root object id a target points at, and the version it came from (if any). */
export async function resolveRoot(opts: SpeckleClientOptions, target: SpeckleTarget): Promise<{ objectId: string; versionId?: string }> {
  if (target.kind === 'object') return { objectId: target.objectId };
  const pinned = target.versionId !== undefined;
  const body = JSON.stringify(
    pinned
      ? { query: VERSION_QUERY, variables: { projectId: target.projectId, versionId: target.versionId } }
      : { query: LATEST_QUERY, variables: { projectId: target.projectId, modelId: target.modelId } },
  );
  const text = await request(opts, `${target.server}/graphql`, 'POST', { 'Content-Type': 'application/json', Accept: 'application/json' }, body);
  const res = parseJson(text, 'the GraphQL response') as {
    data?: { project?: { version?: Version | null; model?: { versions?: { items?: Version[] } } | null } | null };
    errors?: Array<{ message?: string }>;
  };
  if (res.errors && res.errors.length > 0) {
    throw new Error(`speckle.receive: the server answered the version query with an error: ${res.errors.map((e) => e.message ?? '?').join('; ')}`);
  }
  const version = pinned ? res.data?.project?.version : res.data?.project?.model?.versions?.items?.[0];
  if (!version) {
    throw new Error(pinned ? `speckle.receive: version ${target.versionId} was not found in project ${target.projectId}` : `speckle.receive: model ${target.modelId} has no versions`);
  }
  if (typeof version.referencedObject !== 'string' || version.referencedObject.length === 0) {
    throw new Error(`speckle.receive: version ${version.id} carries no referencedObject`);
  }
  return { objectId: version.referencedObject, versionId: version.id };
}

interface Version {
  readonly id: string;
  readonly referencedObject?: string | null;
}

/** Every `referencedId` in an object's own JSON tree, except under display keys. */
export function referencedIds(value: unknown, out: Set<string> = new Set()): Set<string> {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.referencedId === 'string') out.add(o.referencedId);
      for (const [k, child] of Object.entries(o)) {
        if (k === '__closure' || DISPLAY_KEYS.has(k)) continue;
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    }
  }
  return out;
}

function asObject(value: unknown, what: string): SpeckleObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof (value as { id?: unknown }).id !== 'string') {
    throw new Error(`speckle.receive: ${what} is not a Speckle object`);
  }
  return value as SpeckleObject;
}

async function fetchBatch(opts: SpeckleClientOptions, target: SpeckleTarget, ids: readonly string[]): Promise<SpeckleObject[]> {
  const text = await request(
    opts,
    `${target.server}/api/getobjects/${encodeURIComponent(target.projectId)}`,
    'POST',
    { 'Content-Type': 'application/json', Accept: 'text/plain' },
    JSON.stringify({ objects: JSON.stringify(ids) }),
  );
  const out: SpeckleObject[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const tab = line.indexOf('\t');
    out.push(asObject(parseJson(tab >= 0 ? line.slice(tab + 1) : line, `object line "${line.slice(0, 40)}"`), 'a batch line'));
  }
  return out;
}

/**
 * Fetch the root object and everything it references (display geometry
 * excepted), keyed by id. Throws when an id the graph references is not
 * returned by the server, or when `maxObjects` is reached.
 */
export async function fetchObjectGraph(opts: SpeckleClientOptions, target: SpeckleTarget, rootId: string): Promise<Map<string, SpeckleObject>> {
  const objects = new Map<string, SpeckleObject>();
  const rootText = await request(
    opts,
    `${target.server}/objects/${encodeURIComponent(target.projectId)}/${encodeURIComponent(rootId)}/single`,
    'GET',
    { Accept: 'text/plain' },
  );
  const root = asObject(parseJson(rootText, `root object ${rootId}`), `root object ${rootId}`);
  objects.set(rootId, root);
  let frontier = [...referencedIds(root)].filter((id) => !objects.has(id));
  while (frontier.length > 0) {
    if (objects.size + frontier.length > opts.maxObjects) {
      throw new Error(`speckle.receive: the model references more than maxObjects (${opts.maxObjects}) objects; raise maxObjects to receive it`);
    }
    const next = new Set<string>();
    for (let i = 0; i < frontier.length; i += BATCH_SIZE) {
      const ids = frontier.slice(i, i + BATCH_SIZE);
      for (const obj of await fetchBatch(opts, target, ids)) objects.set(obj.id, obj);
      const missing = ids.filter((id) => !objects.has(id));
      if (missing.length > 0) throw new Error(`speckle.receive: the server did not return ${missing.length} referenced object(s), e.g. ${missing[0]}`);
      for (const id of ids) referencedIds(objects.get(id), next);
    }
    frontier = [...next].filter((id) => !objects.has(id));
  }
  return objects;
}
