/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A real OCI registry for the CLI's `oci://` tests: a `node:http` server on
// 127.0.0.1:0 with a Bearer token realm on its own origin. It records every
// request so tests assert on what reached the wire. Adapted from
// packages/oci/test/fake-registry.ts (test helpers are not exported there).

import { createHash } from 'node:crypto';
import * as http from 'node:http';

export interface RecordedRequest {
  url: string;
  authorization?: string;
}

export interface TestLayer {
  bytes: Uint8Array;
  mediaType: string;
  title?: string;
}

export interface TestRegistry {
  /** `127.0.0.1:<port>`. */
  host: string;
  requests: RecordedRequest[];
  /** Serves a manifest at `repo:tag` (and by digest); returns the manifest digest. */
  push(repo: string, tag: string, layers: TestLayer[], artifactType?: string): string;
  /** Serves an index of the given manifest digests at `repo:tag`. */
  pushIndex(repo: string, tag: string, manifests: string[]): void;
  close(): Promise<void>;
}

/** Who may pull: Basic `username:password` at the realm, or a static bearer `token` at the registry. */
export interface TestAccess {
  username?: string;
  password?: string;
  token?: string;
}

const ISSUED_TOKEN = 'issued-by-realm';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';

export function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function reply(res: http.ServerResponse, status: number, body: string | Uint8Array, headers: Record<string, string> = {}): void {
  const bytes = Buffer.from(body);
  res.writeHead(status, { 'content-length': String(bytes.length), ...headers });
  res.end(bytes);
}

export function startTestRegistry(access: TestAccess): Promise<TestRegistry> {
  const requests: RecordedRequest[] = [];
  const routes = new Map<string, { body: Uint8Array; type: string }>();
  let origin = '';
  const basic = access.username === undefined
    ? undefined
    : `Basic ${Buffer.from(`${access.username}:${access.password ?? ''}`).toString('base64')}`;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    requests.push(authorization === undefined ? { url } : { url, authorization });
    if (url.startsWith('/token')) {
      if (basic !== undefined && authorization === basic) {
        return reply(res, 200, JSON.stringify({ token: ISSUED_TOKEN }), { 'content-type': 'application/json' });
      }
      return reply(res, 401, '{"errors":[{"code":"UNAUTHORIZED"}]}');
    }
    const allowed = authorization === `Bearer ${ISSUED_TOKEN}` ||
      (access.token !== undefined && authorization === `Bearer ${access.token}`);
    if (!allowed) {
      return reply(res, 401, '{"errors":[{"code":"UNAUTHORIZED"}]}', {
        'www-authenticate': `Bearer realm="${origin}/token",service="test-registry",scope="repository:placeholder:pull"`,
      });
    }
    const route = routes.get(url);
    if (!route) return reply(res, 404, '{"errors":[{"code":"NAME_UNKNOWN"}]}');
    return reply(res, 200, route.body, { 'content-type': route.type });
  });

  const serveManifest = (repo: string, tag: string, doc: object, type: string): string => {
    const body = new TextEncoder().encode(JSON.stringify(doc));
    const digest = sha256(body);
    routes.set(`/v2/${repo}/manifests/${tag}`, { body, type });
    routes.set(`/v2/${repo}/manifests/${digest}`, { body, type });
    return digest;
  };
  const sizes = new Map<string, number>();

  const registry: Omit<TestRegistry, 'host' | 'close'> = {
    requests,
    push(repo, tag, layers, artifactType = 'application/vnd.ifc-lite.test.v1') {
      const config = new TextEncoder().encode('{}');
      routes.set(`/v2/${repo}/blobs/${sha256(config)}`, { body: config, type: 'application/octet-stream' });
      const descriptors = layers.map((layer) => {
        const digest = sha256(layer.bytes);
        routes.set(`/v2/${repo}/blobs/${digest}`, { body: layer.bytes, type: 'application/octet-stream' });
        return {
          mediaType: layer.mediaType,
          digest,
          size: layer.bytes.byteLength,
          ...(layer.title === undefined ? {} : { annotations: { 'org.opencontainers.image.title': layer.title } }),
        };
      });
      const digest = serveManifest(repo, tag, {
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        artifactType,
        config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: sha256(config), size: config.byteLength },
        layers: descriptors,
      }, OCI_MANIFEST);
      sizes.set(digest, routes.get(`/v2/${repo}/manifests/${digest}`)?.body.byteLength ?? 0);
      return digest;
    },
    pushIndex(repo, tag, manifests) {
      serveManifest(repo, tag, {
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: manifests.map((digest) => ({ mediaType: OCI_MANIFEST, digest, size: sizes.get(digest) ?? 0 })),
      }, OCI_INDEX);
    },
  };

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      origin = `http://127.0.0.1:${port}`;
      resolve({
        ...registry,
        host: `127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}
