/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A registry that stores what it is pushed, for `ifc-lite oci push` tests:
// a `node:http` server on 127.0.0.1:0 with a Bearer token realm on its own
// origin. Uploads must go to a session it issued with a `digest` matching
// the body, a manifest may only name blobs it holds, and writes need a token
// whose scope includes `push`. Pulls are served from the same store, so a
// push can be read back with `oci://` input. Every request is recorded.

import * as http from 'node:http';
import { sha256 } from './oci-test-helpers.js';

export interface PushRecordedRequest {
  method: string;
  url: string;
  authorization?: string;
}

export interface StoredManifest {
  mediaType: string;
  bytes: Uint8Array;
}

export interface PushTestRegistry {
  /** `127.0.0.1:<port>`. */
  host: string;
  requests: PushRecordedRequest[];
  /** `<repo>@<digest>` -> bytes. */
  blobs: Map<string, Uint8Array>;
  /** `<repo>@<digest>` -> manifest. */
  manifests: Map<string, StoredManifest>;
  /** `<repo>:<tag>` -> digest. */
  tags: Map<string, string>;
  /** The manifest a tag points to, parsed. */
  manifestAt(repo: string, tag: string): Record<string, unknown> | undefined;
  close(): Promise<void>;
}

/** Basic `username:password` exchanged at the realm, or a static bearer `token` (granted pull and push). */
export interface PushTestAccess {
  username?: string;
  password?: string;
  token?: string;
}

const MANIFEST_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
]);

function reply(res: http.ServerResponse, status: number, body: string | Uint8Array = '', headers: Record<string, string> = {}): void {
  const bytes = Buffer.from(body);
  res.writeHead(status, { 'content-length': String(bytes.length), ...headers });
  res.end(bytes);
}

function errorReply(res: http.ServerResponse, status: number, code: string, headers: Record<string, string> = {}): void {
  reply(res, status, JSON.stringify({ errors: [{ code, message: code }] }), { 'content-type': 'application/json', ...headers });
}

function readAll(req: http.IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function referencedBlobs(doc: Record<string, unknown>): string[] {
  const out: string[] = [];
  const config = doc.config as { digest?: unknown } | undefined;
  if (typeof config?.digest === 'string') out.push(config.digest);
  for (const layer of Array.isArray(doc.layers) ? doc.layers : []) {
    if (typeof layer?.digest === 'string') out.push(layer.digest);
  }
  return out;
}

export function startPushTestRegistry(access: PushTestAccess): Promise<PushTestRegistry> {
  const requests: PushRecordedRequest[] = [];
  const blobs = new Map<string, Uint8Array>();
  const manifests = new Map<string, StoredManifest>();
  const tags = new Map<string, string>();
  /** Issued token -> the scope it was issued for. */
  const issued = new Map<string, string>();
  const sessions = new Set<string>();
  let nextId = 0;
  let origin = '';
  const basic = access.username === undefined
    ? undefined
    : `Basic ${Buffer.from(`${access.username}:${access.password ?? ''}`).toString('base64')}`;

  /** The scope an Authorization header grants, or undefined. */
  const grantOf = (authorization: string | undefined): string | undefined => {
    if (authorization === undefined || !authorization.startsWith('Bearer ')) return undefined;
    const token = authorization.slice('Bearer '.length);
    if (access.token !== undefined && token === access.token) return '*';
    return issued.get(token);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    requests.push(authorization === undefined ? { method, url: rawUrl } : { method, url: rawUrl, authorization });
    const url = new URL(rawUrl, 'http://registry.invalid');

    if (url.pathname === '/token') {
      if (basic === undefined || authorization !== basic) return errorReply(res, 401, 'UNAUTHORIZED');
      const token = `issued-${++nextId}`;
      issued.set(token, url.searchParams.get('scope') ?? '');
      return reply(res, 200, JSON.stringify({ token }), { 'content-type': 'application/json' });
    }

    const match = /^\/v2\/(.+?)\/(blobs\/uploads\/[^/]*|blobs\/[^/]+|manifests\/[^/]+)$/.exec(url.pathname);
    if (!match) return errorReply(res, 404, 'NAME_UNKNOWN');
    const [, repo, rest] = match;
    const write = method === 'POST' || method === 'PUT';
    const grant = grantOf(authorization);
    const challenge = { 'www-authenticate': `Bearer realm="${origin}/token",service="push-test",scope="repository:placeholder:pull"` };
    if (grant === undefined) return errorReply(res, 401, 'UNAUTHORIZED', challenge);
    const actions = grant === '*' ? ['pull', 'push'] : (grant.startsWith(`repository:${repo}:`) ? grant.split(':')[2].split(',') : []);
    if (!actions.includes(write ? 'push' : 'pull')) return errorReply(res, 401, 'DENIED', challenge);

    if (rest === 'blobs/uploads/' && method === 'POST') {
      const session = `u${++nextId}`;
      sessions.add(session);
      return reply(res, 202, '', { location: `/v2/${repo}/blobs/uploads/${session}?_state=x`, 'docker-upload-uuid': session });
    }
    const upload = /^blobs\/uploads\/([^/]+)$/.exec(rest);
    if (upload && method === 'PUT') {
      if (!sessions.delete(upload[1])) return errorReply(res, 404, 'BLOB_UPLOAD_UNKNOWN');
      const body = await readAll(req);
      const digest = url.searchParams.get('digest');
      if (digest === null || sha256(body) !== digest) return errorReply(res, 400, 'DIGEST_INVALID');
      blobs.set(`${repo}@${digest}`, body);
      return reply(res, 201, '', { location: `/v2/${repo}/blobs/${digest}`, 'docker-content-digest': digest });
    }
    const blob = /^blobs\/(sha256:[a-f0-9]{64})$/.exec(rest);
    if (blob && (method === 'GET' || method === 'HEAD')) {
      const bytes = blobs.get(`${repo}@${blob[1]}`);
      if (!bytes) return errorReply(res, 404, 'BLOB_UNKNOWN');
      if (method === 'HEAD') {
        res.writeHead(200, { 'content-length': String(bytes.length), 'docker-content-digest': blob[1] });
        return void res.end();
      }
      return reply(res, 200, bytes, { 'content-type': 'application/octet-stream', 'docker-content-digest': blob[1] });
    }
    const manifest = /^manifests\/([^/]+)$/.exec(rest);
    if (manifest && method === 'PUT') {
      const reference = manifest[1];
      const mediaType = String(req.headers['content-type'] ?? '');
      const body = await readAll(req);
      const digest = sha256(body);
      if (!MANIFEST_TYPES.has(mediaType)) return errorReply(res, 400, 'MANIFEST_INVALID');
      if (reference.startsWith('sha256:') && reference !== digest) return errorReply(res, 400, 'DIGEST_INVALID');
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
      } catch {
        return errorReply(res, 400, 'MANIFEST_INVALID');
      }
      if (referencedBlobs(doc).some((d) => !blobs.has(`${repo}@${d}`))) return errorReply(res, 400, 'MANIFEST_BLOB_UNKNOWN');
      manifests.set(`${repo}@${digest}`, { mediaType, bytes: body });
      if (!reference.startsWith('sha256:')) tags.set(`${repo}:${reference}`, digest);
      return reply(res, 201, '', { 'docker-content-digest': digest, location: `/v2/${repo}/manifests/${digest}` });
    }
    if (manifest && (method === 'GET' || method === 'HEAD')) {
      const reference = manifest[1];
      const digest = reference.startsWith('sha256:') ? reference : tags.get(`${repo}:${reference}`);
      const entry = digest === undefined ? undefined : manifests.get(`${repo}@${digest}`);
      if (!entry || digest === undefined) return errorReply(res, 404, 'MANIFEST_UNKNOWN');
      const headers = { 'content-type': entry.mediaType, 'docker-content-digest': digest };
      if (method === 'HEAD') {
        res.writeHead(200, { ...headers, 'content-length': String(entry.bytes.length) });
        return void res.end();
      }
      return reply(res, 200, entry.bytes, headers);
    }
    return errorReply(res, 405, 'UNSUPPORTED');
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      errorReply(res, 500, `INTERNAL ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      origin = `http://127.0.0.1:${port}`;
      resolve({
        host: `127.0.0.1:${port}`,
        requests,
        blobs,
        manifests,
        tags,
        manifestAt(repo, tag) {
          const digest = tags.get(`${repo}:${tag}`);
          const entry = digest === undefined ? undefined : manifests.get(`${repo}@${digest}`);
          return entry === undefined ? undefined : JSON.parse(Buffer.from(entry.bytes).toString('utf8')) as Record<string, unknown>;
        },
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}
