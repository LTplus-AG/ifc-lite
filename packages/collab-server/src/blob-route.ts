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
 * Authentication is intentionally NOT included here — the existing
 * `AuthenticateFn` only sees websocket upgrades. Production deployments
 * should layer their own JWT validation in front of this route (e.g. a
 * reverse proxy). For dev/tests we accept anonymous traffic.
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

export interface BlobRouteOptions {
  storage: ServerBlobStorage;
  /** Reject PUTs over this size (default 100 MB). */
  maxBytes?: number;
  /**
   * If set, server recomputes a sha256 of the body and 409s when it
   * doesn't match the URL hash. Defaults to `false` because clients use
   * `fnv128` which is not sha256-compatible.
   */
  verifySha256?: boolean;
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

  if (url.pathname === '/blobs' || url.pathname === '/blobs/') {
    if (req.method === 'GET') {
      return opts.storage.list().then((hashes) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hashes }));
        return true;
      });
    }
    res.writeHead(405);
    res.end();
    return true;
  }

  const hash = url.pathname.slice('/blobs/'.length);
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
