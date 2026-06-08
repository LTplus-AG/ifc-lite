/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HTTP blob route (spec §11.1 + §11.3).
 *
 * Mounts `/blobs/<hash>` (PUT/GET/HEAD/DELETE) and `/blobs` (GET list)
 * on the supplied http server. Storage is pluggable so deployments can
 * back this with S3, GCS, local disk, or in-memory for tests.
 *
 * Authentication reuses the same `AuthenticateFn` as the websocket sync
 * path: `startCollabServer` wires its `authenticate` hook in here via the
 * `authorize` option, so a deployment that supplies real auth gets its
 * blob route gated with the same token (no separate scheme). When no
 * authorizer is supplied (dev/tests, or the anonymous default) traffic is
 * accepted, matching the websocket path's behaviour. Production
 * deployments may additionally layer JWT validation at a reverse proxy.
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';

export interface ServerBlobMeta {
  hash: string;
  byteLength: number;
  contentType?: string;
  uploadedAt: string;
}

export interface ServerBlobStorage {
  put(hash: string, bytes: Uint8Array, contentType?: string): Promise<ServerBlobMeta>;
  get(hash: string): Promise<{ bytes: Uint8Array; meta: ServerBlobMeta } | null>;
  has(hash: string): Promise<boolean>;
  delete(hash: string): Promise<boolean>;
  list(): Promise<string[]>;
}

/** In-memory storage. Default for tests + dev. */
export class InMemoryBlobStorage implements ServerBlobStorage {
  private readonly blobs = new Map<string, { bytes: Uint8Array; meta: ServerBlobMeta }>();

  async put(hash: string, bytes: Uint8Array, contentType?: string): Promise<ServerBlobMeta> {
    const meta: ServerBlobMeta = {
      hash,
      byteLength: bytes.byteLength,
      contentType,
      uploadedAt: new Date().toISOString(),
    };
    this.blobs.set(hash, { bytes: new Uint8Array(bytes), meta });
    return meta;
  }
  async get(hash: string) {
    const v = this.blobs.get(hash);
    return v ? { bytes: new Uint8Array(v.bytes), meta: v.meta } : null;
  }
  async has(hash: string) {
    return this.blobs.has(hash);
  }
  async delete(hash: string) {
    return this.blobs.delete(hash);
  }
  async list() {
    return Array.from(this.blobs.keys());
  }
}

/** Match exactly 32 lowercase hex chars (the client's `fnv128` output). */
const HASH_REGEX = /^[a-f0-9]{32}$/;

/**
 * Authorizer for blob requests. Returns `true` to allow the operation,
 * `false` to reject with 401. `method` is the HTTP verb, `hash` is the
 * target hash (undefined for the `/blobs` list endpoint). `token` is the
 * bearer / `?token=` credential lifted from the request. Reuses the same
 * credential the websocket sync path consumes.
 */
export type BlobAuthorizeFn = (
  token: string | undefined,
  method: string,
  hash: string | undefined,
) => Promise<boolean> | boolean;

export interface BlobRouteOptions {
  storage: ServerBlobStorage;
  /** Reject PUTs over this size (default 100 MB). */
  maxBytes?: number;
  /**
   * Optional authorizer. When supplied, every request must pass it before
   * any storage access (GET/HEAD/PUT/DELETE and the `/blobs` list). When
   * omitted, traffic is anonymous (dev/tests). `startCollabServer` wires
   * this from its `authenticate` hook so blobs share the WS auth scheme.
   */
  authorize?: BlobAuthorizeFn;
  /**
   * If set, server recomputes a sha256 of the body and 409s when it
   * doesn't match the URL hash. Defaults to `false` because clients use
   * `fnv128` which is not sha256-compatible.
   */
  verifySha256?: boolean;
}

/**
 * Lift the auth credential from a request: prefer the `Authorization:
 * Bearer <token>` header, fall back to a `?token=` query param (matching
 * the websocket upgrade path, which reads `?token=`).
 */
function extractToken(req: http.IncomingMessage, url: URL): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return m[1];
  }
  return url.searchParams.get('token') ?? undefined;
}

/**
 * Route handler for `/blobs/...` requests. Returns `true` if the
 * request was handled (the caller should not write its own response).
 */
export function handleBlobRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: BlobRouteOptions,
): Promise<boolean> | boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/blobs')) return false;
  // We own this request; auth + dispatch run async so the authorizer can be
  // a Promise. Returns true once a response is written.
  return routeBlob(req, res, opts, url);
}

async function routeBlob(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: BlobRouteOptions,
  url: URL,
): Promise<true> {
  const isList = url.pathname === '/blobs' || url.pathname === '/blobs/';
  const hash = isList ? undefined : url.pathname.slice('/blobs/'.length);

  // Gate every operation (list + GET/HEAD/PUT/DELETE) on the shared
  // authorizer before touching storage. Reuses the WS sync token.
  if (opts.authorize) {
    const token = extractToken(req, url);
    const allowed = await opts.authorize(token, req.method ?? 'GET', hash);
    if (!allowed) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }
  }

  if (hash === undefined) {
    if (req.method === 'GET') {
      const hashes = await opts.storage.list();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hashes }));
      return true;
    }
    res.writeHead(405);
    res.end();
    return true;
  }

  if (!HASH_REGEX.test(hash)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid-hash' }));
    return true;
  }

  switch (req.method) {
    case 'PUT':
      return handlePut(req, res, hash, opts);
    case 'GET':
      return handleGet(res, hash, opts);
    case 'HEAD':
      return handleHead(res, hash, opts);
    case 'DELETE':
      return handleDelete(res, hash, opts);
    default:
      res.writeHead(405);
      res.end();
      return true;
  }
}

async function handlePut(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hash: string,
  opts: BlobRouteOptions,
): Promise<true> {
  const max = opts.maxBytes ?? 100 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > max) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload-too-large', max }));
      req.destroy();
      return true;
    }
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks);

  if (opts.verifySha256) {
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    if (sha !== hash) {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'hash-mismatch', expected: hash, computed: sha }));
      return true;
    }
  }

  const contentType = (req.headers['content-type'] as string | undefined) ?? undefined;
  const meta = await opts.storage.put(hash, body, contentType);
  res.writeHead(201, { 'content-type': 'application/json' });
  res.end(JSON.stringify(meta));
  return true;
}

async function handleGet(
  res: http.ServerResponse,
  hash: string,
  opts: BlobRouteOptions,
): Promise<true> {
  const v = await opts.storage.get(hash);
  if (!v) {
    res.writeHead(404);
    res.end();
    return true;
  }
  res.writeHead(200, {
    'content-type': v.meta.contentType ?? 'application/octet-stream',
    'content-length': String(v.meta.byteLength),
    'x-blob-hash': v.meta.hash,
  });
  res.end(Buffer.from(v.bytes));
  return true;
}

async function handleHead(
  res: http.ServerResponse,
  hash: string,
  opts: BlobRouteOptions,
): Promise<true> {
  const exists = await opts.storage.has(hash);
  res.writeHead(exists ? 200 : 404);
  res.end();
  return true;
}

async function handleDelete(
  res: http.ServerResponse,
  hash: string,
  opts: BlobRouteOptions,
): Promise<true> {
  const ok = await opts.storage.delete(hash);
  res.writeHead(ok ? 204 : 404);
  res.end();
  return true;
}
