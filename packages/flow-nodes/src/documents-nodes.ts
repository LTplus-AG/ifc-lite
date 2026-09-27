/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `documents.*` — the OpenCDE Documents API 1.0 (`@ifc-lite/documents-api`)
 * as flow nodes (#5167 phase 3.4): poll a tracked set of documents for new
 * versions, and download a version's file.
 *
 * Every request goes through `gatedFetch` (see `documents-fetch.ts`), i.e.
 * the same `coreNetworkRequest` grant check `http.request` runs: the graph
 * must declare `network.fetch:<cde-host>` for the host it talks to. Both
 * nodes are `volatile` — a CDE's answer is the world outside the graph, so
 * a rerun must ask again rather than replay a memo.
 *
 * The bearer token is an ordinary string param, so it is written as
 * `{{secret:NAME}}` (with `secret.read:NAME` declared); the CLI/MCP runner
 * substitutes it before this node runs and redacts it from the run output.
 *
 * A downloaded file travels an edge as base64 text, the encoding
 * `table.readXlsx` already reads, because a flow `Scalar` has no bytes.
 */

import { DocumentsApiClient, type DocumentVersion } from '@ifc-lite/documents-api';
import type { Column, Table } from '@ifc-lite/flow';
import { toBase64 } from './base64.js';
import { gatedFetch } from './documents-fetch.js';
import { boundOr } from './http-request-node.js';
import { SCALAR_ITEM, SCALAR_LIST, TABLE_ITEM, type Ctx, type FlowNodeDef } from './host.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_QUERY_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;

const TOKEN_PARAM = {
  name: 'token',
  kind: 'string',
  default: '',
  doc: 'Bearer access token, normally `{{secret:NAME}}` with `secret.read:NAME` declared. Empty for an anonymous server.',
} as const;

function tokenProvider(raw: unknown): (() => string) | undefined {
  const token = typeof raw === 'string' ? raw.trim().replace(/^Bearer\s+/i, '') : '';
  return token.length > 0 ? () => token : undefined;
}

function client(ctx: Ctx, label: string, baseUrl: string, p: Readonly<Record<string, unknown>>, maxBytes: number): DocumentsApiClient {
  return new DocumentsApiClient({
    baseUrl,
    getAccessToken: tokenProvider(p.token),
    fetchFn: gatedFetch(ctx, { label, timeoutMs: boundOr(p.timeoutMs, DEFAULT_TIMEOUT_MS, 1), maxBytes: boundOr(p.maxBytes, maxBytes, 0) }),
  });
}

/** Document ids from the wired list, else the param (a JSON array or a comma-separated string). */
function documentIds(input: unknown, param: unknown): string[] {
  const raw = Array.isArray(input) ? input : Array.isArray(param) ? param : typeof param === 'string' ? param.split(',') : [];
  return raw.map((v) => String(v ?? '').trim()).filter((v) => v.length > 0);
}

export const VERSION_COLUMNS: readonly Column[] = [
  { name: 'document_id', type: 'identifier' },
  { name: 'version_number', type: 'label' },
  { name: 'version_index', type: 'integer' },
  { name: 'title', type: 'string' },
  { name: 'creation_date', type: 'string' },
  { name: 'file_name', type: 'string' },
  { name: 'size_in_bytes', type: 'integer' },
  { name: 'download_url', type: 'string' },
];

function versionsTable(versions: readonly DocumentVersion[]): Table {
  return {
    columns: VERSION_COLUMNS,
    key: 'document_id',
    rows: versions.map((v) => ({
      document_id: v.document_id,
      version_number: v.version_number,
      version_index: v.version_index,
      title: v.title,
      creation_date: v.creation_date,
      file_name: v.file_description?.name ?? null,
      size_in_bytes: v.file_description?.size_in_bytes ?? null,
      download_url: v.links?.document_version_download?.url ?? null,
    })),
  };
}

/** Last path segment of `url`, decoded — the fallback file name for a download. */
function nameFromUrl(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : 'download';
  } catch {
    // Not a parseable URL: the request itself already failed on it.
    return 'download';
  }
}

const NETWORK_NODE = {
  capabilities: ['network.fetch:*'],
  requires: { network: true },
  // A cached answer would skip the request and report a stale CDE state.
  volatile: true,
} as const;

export const documentsNodes: FlowNodeDef[] = [
  {
    type: 'documents.queryVersions',
    title: 'Query document versions',
    category: 'network',
    doc: 'Polls an OpenCDE Documents API server (`POST /document-versions`) for the latest version of each document id. Pass the ETag of the previous poll: when the server answers 304, `changed` is false, `versions` is empty and `etag` echoes the one sent.',
    inputs: [
      { name: 'documentIds', type: SCALAR_LIST, optional: true },
      { name: 'etag', type: SCALAR_ITEM, optional: true, nullable: true },
    ],
    outputs: [
      { name: 'versions', type: TABLE_ITEM },
      { name: 'etag', type: SCALAR_ITEM },
      { name: 'changed', type: SCALAR_ITEM },
    ],
    params: [
      { name: 'baseUrl', kind: 'string', default: '', doc: 'Documents API base URL, e.g. https://cde.example/documents/1.0. Its host must be granted with network.fetch:<host>.' },
      { name: 'documentIds', kind: 'json', default: [], doc: 'Document ids to poll, used when the `documentIds` input is not wired.' },
      { name: 'etag', kind: 'string', default: '', doc: 'ETag of the previous poll, used when the `etag` input is not wired.' },
      TOKEN_PARAM,
      { name: 'timeoutMs', kind: 'number', default: DEFAULT_TIMEOUT_MS },
      { name: 'maxBytes', kind: 'number', default: DEFAULT_QUERY_MAX_BYTES, doc: 'Largest response accepted; a larger one fails the node.' },
    ],
    ...NETWORK_NODE,
    run: async (ctx, i, p) => {
      const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '';
      if (baseUrl.length === 0) throw new Error('documents.queryVersions: "baseUrl" is required');
      const ids = documentIds(i.documentIds, p.documentIds);
      if (ids.length === 0) throw new Error('documents.queryVersions: no document ids to query');
      const previous = typeof i.etag === 'string' && i.etag.length > 0 ? i.etag : typeof p.etag === 'string' && p.etag.length > 0 ? p.etag : undefined;
      const poll = await client(ctx, 'documents.queryVersions', baseUrl, p, DEFAULT_QUERY_MAX_BYTES).queryDocumentVersions(ids, previous);
      if (poll === null) return { versions: versionsTable([]), etag: previous ?? null, changed: false };
      return { versions: versionsTable(poll.result.versions ?? []), etag: poll.etag, changed: true };
    },
  },
  {
    type: 'documents.download',
    title: 'Download document',
    category: 'network',
    doc: 'Downloads one document version from its `document_version_download` link (the `download_url` column of Query document versions). `data` is the file as base64; `name` is the wired name, else the URL\'s last path segment.',
    inputs: [
      { name: 'url', type: SCALAR_ITEM, optional: true },
      { name: 'name', type: SCALAR_ITEM, optional: true, nullable: true },
    ],
    outputs: [
      { name: 'data', type: SCALAR_ITEM },
      { name: 'name', type: SCALAR_ITEM },
      { name: 'size', type: SCALAR_ITEM },
      { name: 'contentType', type: SCALAR_ITEM },
    ],
    params: [
      { name: 'url', kind: 'string', default: '', doc: 'Download URL, used when the `url` input is not wired. Its host must be granted with network.fetch:<host>.' },
      TOKEN_PARAM,
      { name: 'timeoutMs', kind: 'number', default: DEFAULT_TIMEOUT_MS },
      { name: 'maxBytes', kind: 'number', default: DEFAULT_DOWNLOAD_MAX_BYTES, doc: 'Largest file accepted; a larger one fails the node rather than yielding a truncated file.' },
    ],
    ...NETWORK_NODE,
    run: async (ctx, i, p) => {
      const url = typeof i.url === 'string' && i.url.length > 0 ? i.url : typeof p.url === 'string' ? p.url.trim() : '';
      if (url.length === 0) throw new Error('documents.download: "url" is required');
      // The download link is absolute and server-issued, so the client's base URL is never used here.
      const blob = await client(ctx, 'documents.download', url, p, DEFAULT_DOWNLOAD_MAX_BYTES).downloadDocumentVersion(url);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const name = typeof i.name === 'string' && i.name.length > 0 ? i.name : nameFromUrl(url);
      return { data: toBase64(bytes), name, size: bytes.byteLength, contentType: blob.type || null };
    },
  },
];
