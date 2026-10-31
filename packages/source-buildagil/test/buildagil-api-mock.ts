/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In-memory stand-in for buildagil's openCDE API, shaped after its published
 * OpenAPI document (buildagil openCDE API 1.0, SwaggerHub, 2026-10-27): the
 * endpoints the provider calls, `$filter` with `file_type eq` / `creation_date
 * ge`, `$orderby=creation_date asc`, `$top` (default 100) and no `$skip`.
 */

import type { KeyValueStore, PluginContext } from '@ifc-lite/plugin-api';
import { tokenManager } from '../src/auth.js';

export const ACCESS_TOKEN = 'mock-access-token';

export interface MockDocument {
  guid: string;
  filename: string;
  folder_url: string;
  creation_date: string;
  versions: { version_index: number; version_number: string; modified_date: string; content: string }[];
  file_type?: string;
}

export interface MockWorld {
  projects: { project_id: string; name: string; number?: string }[];
  documents: Record<string, MockDocument[]>;
}

export interface MockCall { url: URL; method: string; headers: Headers; body: string }

const API = 'https://openapi.buildagil.com';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function documentRow(doc: MockDocument) {
  const latest = doc.versions.at(-1)!;
  return {
    guid: doc.guid, filename: doc.filename, file_type: doc.file_type ?? doc.filename.split('.').pop(), folder_url: doc.folder_url,
    version_number: latest.version_number, version_index: latest.version_index, creation_date: doc.creation_date,
    modified_date: latest.modified_date, size_in_bytes: latest.content.length, status: 'Released',
    link: `https://app.buildagil.com/open?guid=${doc.guid}`,
  };
}

/** The subset of the OData `$filter` the provider sends, evaluated for real. */
function matchesFilter(doc: MockDocument, filter: string): boolean {
  const types = [...filter.matchAll(/file_type eq '([^']*)'/g)].map((match) => match[1]);
  const type = doc.file_type ?? doc.filename.split('.').pop() ?? '';
  if (types.length > 0 && !types.includes(type)) return false;
  const after = /creation_date ge (\S+)/.exec(filter)?.[1];
  return !after || doc.creation_date >= after;
}

function memoryStorage(): KeyValueStore {
  const store = new Map<string, string>();
  return {
    get: async (key) => store.get(key),
    set: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
    keys: async () => [...store.keys()],
  };
}

/**
 * A context factory over one world. Contexts share storage and fetch, as the
 * host's do (both derive from the manifest), and the session is signed in.
 */
export function createMockApi(world: MockWorld, clientId = 'client-1') {
  const calls: MockCall[] = [];
  const storage = memoryStorage();
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method, headers, body });
    if (url.origin !== API) throw new Error(`Unexpected host: ${url.origin}`);
    if (url.pathname === '/oauth2/token') {
      return json({ access_token: ACCESS_TOKEN, refresh_token: 'rt-2', expires_in: 3600, token_type: 'Bearer' });
    }
    if (headers.get('authorization') !== `Bearer ${ACCESS_TOKEN}`) return json({ message: 'error occurred' }, 401);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/1.0/projects') return json(world.projects);
    if (url.pathname === '/1.0/search' && method === 'POST') {
      const request = JSON.parse(body) as { search_text: string; project_ids: string[]; limit: number; offset: number };
      const hits = request.project_ids.flatMap((id) => world.documents[id] ?? [])
        .filter((doc) => doc.filename.toLowerCase().includes(request.search_text.toLowerCase()));
      return json({
        search_result: hits.slice(request.offset, request.offset + request.limit).map((doc) => ({ ...documentRow(doc), type: 'Document' })),
        total_count: hits.length,
      });
    }
    const [, , projectId, collection, guid, sub, index] = parts;
    const docs = world.documents[projectId ?? ''];
    if (parts[0] !== '1.0' || parts[1] !== 'projects' || collection !== 'documents' || !docs) return json({ statusCode: 404 }, 404);
    if (!guid) {
      const filter = url.searchParams.get('$filter') ?? '';
      const top = Number(url.searchParams.get('$top') ?? 100);
      const ordered = docs.filter((doc) => matchesFilter(doc, filter))
        .sort((a, b) => a.creation_date.localeCompare(b.creation_date));
      return json(ordered.slice(0, top).map(documentRow));
    }
    const doc = docs.find((candidate) => candidate.guid === guid);
    if (!doc) return json({ statusCode: 404 }, 404);
    if (sub === undefined) return new Response(doc.versions.at(-1)!.content);
    if (sub === 'versions' && index === undefined) {
      return json(doc.versions.map(({ content, ...version }) => ({ ...version, size_in_bytes: content.length })));
    }
    const version = sub === 'versions' ? doc.versions.find((candidate) => String(candidate.version_index) === index) : undefined;
    return version ? new Response(version.content) : json({ statusCode: 404 }, 404);
  };
  const createContext = (): PluginContext => ({
    fetch: fetchImpl as typeof fetch,
    fetchPublic: async () => { throw new Error('buildagil never uses fetchPublic'); },
    getPreference: async () => undefined,
    storage,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const signIn = () => tokenManager(createContext(), clientId).setTokens({
    accessToken: ACCESS_TOKEN, refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000,
  });
  return { calls, createContext, signIn, storage };
}

/** `n` IFC documents in one folder, created one second apart. */
export function manyDocuments(n: number, folder = '/documents/bulk'): MockDocument[] {
  return Array.from({ length: n }, (_, i) => ({
    guid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    filename: `model-${String(i).padStart(4, '0')}.ifc`,
    folder_url: folder,
    creation_date: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    versions: [{ version_index: 1, version_number: '1', modified_date: '2026-02-01T00:00:00.000Z', content: `IFC-${i}` }],
  }));
}
