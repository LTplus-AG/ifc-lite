/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A registry that actually stores what it is sent, enforcing the parts of the
// distribution spec a pushing client depends on: an upload must go to a
// session the server issued, the `digest` query must match the body's
// sha256, and a manifest may only name blobs already stored. Pulls are served
// from the same store, so a push can be read back with the pull API.

import type * as http from 'node:http';
import { OciError } from '../src/index.js';
import { send, sha256, type Handler } from './fake-registry.js';

export interface PushStore {
  blobs: Map<string, Uint8Array>;
  /** Keyed by digest. */
  manifests: Map<string, { mediaType: string; bytes: Uint8Array }>;
  /** tag -> digest. */
  tags: Map<string, string>;
}

export interface PushRegistryOptions {
  /** Repository served; others get 404 NAME_UNKNOWN. */
  repository?: string;
  /** Builds the upload `Location` for a new session. Default: relative path with a `_state` query. */
  location?: (session: string, req: http.IncomingMessage) => string;
  /** Overrides the `Docker-Content-Digest` sent on a blob PUT. */
  blobDigestHeader?: (digest: string) => string | undefined;
  /** Gate as in `registry()`: false -> 401 (with `challenge` when set), 'deny' -> 403. */
  accept?: (authorization: string | undefined, req: http.IncomingMessage) => boolean | 'deny';
  challenge?: string;
}

function readAll(req: http.IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function error(res: http.ServerResponse, status: number, code: string): void {
  send(res, { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ errors: [{ code, message: code }] }) });
}

/** Digests a manifest names (config, layers, index children). */
function referencedBlobs(doc: Record<string, unknown>): string[] {
  const out: string[] = [];
  const config = doc.config as { digest?: unknown } | undefined;
  if (typeof config?.digest === 'string') out.push(config.digest);
  for (const layer of Array.isArray(doc.layers) ? doc.layers : []) {
    if (typeof layer?.digest === 'string') out.push(layer.digest);
  }
  return out;
}

export function pushRegistry(options: PushRegistryOptions = {}): { handler: Handler; store: PushStore } {
  const repo = options.repository ?? 'team/model';
  const store: PushStore = { blobs: new Map(), manifests: new Map(), tags: new Map() };
  const sessions = new Set<string>();
  let nextSession = 0;
  const prefix = `/v2/${repo}`;

  const handler: Handler = async (req, res) => {
    if (options.accept) {
      const verdict = options.accept(req.headers.authorization, req);
      if (verdict === 'deny') return error(res, 403, 'DENIED');
      if (!verdict) {
        if (options.challenge !== undefined) res.setHeader('www-authenticate', options.challenge);
        return error(res, 401, 'UNAUTHORIZED');
      }
    }
    const url = new URL(req.url ?? '/', 'http://registry.invalid');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (!path.startsWith(`${prefix}/`)) return error(res, 404, 'NAME_UNKNOWN');
    const rest = path.slice(prefix.length);

    if (rest === '/blobs/uploads/' && method === 'POST') {
      const session = `s${++nextSession}`;
      sessions.add(session);
      const location = options.location ? options.location(session, req) : `${prefix}/blobs/uploads/${session}?_state=abc%3D%3D&x=1`;
      return send(res, { status: 202, headers: { location, 'docker-upload-uuid': session, range: '0-0' } });
    }
    const uploadMatch = /^\/blobs\/uploads\/([^/]+)$/.exec(rest);
    if (uploadMatch && method === 'PUT') {
      const session = uploadMatch[1];
      if (!sessions.has(session)) return error(res, 404, 'BLOB_UPLOAD_UNKNOWN');
      const body = await readAll(req);
      const digest = url.searchParams.get('digest');
      if (digest === null || sha256(body) !== digest) return error(res, 400, 'DIGEST_INVALID');
      sessions.delete(session);
      store.blobs.set(digest, body);
      const header = options.blobDigestHeader ? options.blobDigestHeader(digest) : digest;
      const headers: Record<string, string> = { location: `${prefix}/blobs/${digest}` };
      if (header !== undefined) headers['docker-content-digest'] = header;
      return send(res, { status: 201, headers });
    }
    const blobMatch = /^\/blobs\/(sha256:[a-f0-9]{64})$/.exec(rest);
    if (blobMatch && (method === 'HEAD' || method === 'GET')) {
      const bytes = store.blobs.get(blobMatch[1]);
      if (!bytes) return error(res, 404, 'BLOB_UNKNOWN');
      const headers = { 'docker-content-digest': blobMatch[1], 'content-type': 'application/octet-stream' };
      if (method === 'HEAD') {
        res.writeHead(200, { ...headers, 'content-length': String(bytes.length) });
        return void res.end();
      }
      return send(res, { headers, body: bytes });
    }
    const manifestMatch = /^\/manifests\/([^/]+)$/.exec(rest);
    if (manifestMatch && method === 'PUT') {
      const reference = manifestMatch[1];
      const body = await readAll(req);
      const digest = sha256(body);
      if (reference.startsWith('sha256:') && reference !== digest) return error(res, 400, 'DIGEST_INVALID');
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
      } catch {
        return error(res, 400, 'MANIFEST_INVALID');
      }
      if (referencedBlobs(doc).some((d) => !store.blobs.has(d))) return error(res, 400, 'MANIFEST_BLOB_UNKNOWN');
      store.manifests.set(digest, { mediaType: String(req.headers['content-type'] ?? ''), bytes: body });
      if (!reference.startsWith('sha256:')) store.tags.set(reference, digest);
      return send(res, { status: 201, headers: { 'docker-content-digest': digest, location: `${prefix}/manifests/${digest}` } });
    }
    if (manifestMatch && (method === 'HEAD' || method === 'GET')) {
      const reference = manifestMatch[1];
      const digest = reference.startsWith('sha256:') ? reference : store.tags.get(reference);
      const entry = digest === undefined ? undefined : store.manifests.get(digest);
      if (!entry || digest === undefined) return error(res, 404, 'MANIFEST_UNKNOWN');
      const headers = { 'docker-content-digest': digest, 'content-type': entry.mediaType };
      if (method === 'HEAD') {
        res.writeHead(200, { ...headers, 'content-length': String(entry.bytes.length) });
        return void res.end();
      }
      return send(res, { headers, body: entry.bytes });
    }
    return error(res, 404, 'UNSUPPORTED');
  };
  return { handler, store };
}

/** Awaits a promise that must reject with an `OciError`, and returns it. */
export async function ociFailure(promise: Promise<unknown>): Promise<OciError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof OciError) return err;
    throw err;
  }
  throw new Error('expected the call to reject');
}
