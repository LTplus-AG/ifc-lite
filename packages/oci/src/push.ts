/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { pushScope } from './auth.js';
import { finishDigest } from './digest.js';
import { OciError } from './errors.js';
import { MANIFEST_ACCEPT, parseManifestDocument } from './manifest-shape.js';
import { checkRepositoryRef, manifestReference } from './reference.js';
import { authorizedRequest, pushFailure, type Session } from './session.js';
import { fetchFollowing, sendOnce, type FollowResult } from './transport.js';
import type { OciPushedBlob, OciPushedManifest, OciPushManifestOptions, OciReference, OciRepositoryRef } from './types.js';

/** Accepts only a `Uint8Array` (a Node `Buffer` is one) and returns ArrayBuffer-backed bytes. */
export function requireBytes(value: unknown, what: string): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array)) throw new TypeError(`@ifc-lite/oci: ${what} must be a Uint8Array`);
  // A view over a SharedArrayBuffer is copied: WebCrypto and fetch bodies take ArrayBuffer views.
  return value.buffer instanceof ArrayBuffer ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value);
}

/** `sha256:<hex>` of a complete buffer, through `createHasher` when the client has one. */
export async function digestOf(session: Session, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hasher = session.createHasher?.();
  hasher?.update(bytes);
  return finishDigest(bytes, hasher);
}

/**
 * Resolves an upload `Location` against the URL that returned it, refuses
 * any other origin (the upload body and the credentials stay on the
 * registry), and appends `digest` while keeping the registry's own query
 * (`_state` and friends) byte for byte.
 */
export function uploadTarget(location: string, requestUrl: string, origin: string, digest: string, what: string): string {
  let url: URL;
  try {
    url = new URL(location, requestUrl);
  } catch (err) {
    throw new OciError('PROTOCOL', `${what}: unparseable upload Location`, { cause: err });
  }
  if (url.username || url.password) throw new OciError('PROTOCOL', `${what}: upload Location carries userinfo`);
  if (url.origin !== origin) {
    throw new OciError('PROTOCOL', `${what}: upload Location points to another origin (${url.origin}); refusing to send the blob there`);
  }
  url.hash = '';
  const base = url.href.endsWith('?') ? url.href.slice(0, -1) : url.href;
  return `${base}${url.search === '' ? '?' : '&'}digest=${encodeURIComponent(digest)}`;
}

function checkDigestHeader(response: Response, digest: string, what: string): void {
  const header = response.headers.get('docker-content-digest');
  if (header !== null && header.trim() !== digest) {
    throw new OciError('DIGEST_MISMATCH', `${what}: registry reports Docker-Content-Digest ${header.trim()}, the bytes sent hash to ${digest}`);
  }
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  return raw !== null && /^[0-9]+$/.test(raw) ? Number(raw) : undefined;
}

interface Target {
  session: Session;
  origin: string;
  repository: string;
  what: string;
  signal: AbortSignal | undefined;
}

function head(t: Target, url: string, accept: string): Promise<FollowResult> {
  return authorizedRequest(t.session, {
    origin: t.origin,
    scope: pushScope(t.repository),
    what: t.what,
    signal: t.signal,
    denyInsufficientScope: true,
    send: (authorization) =>
      fetchFollowing(url, {
        fetch: t.session.fetch,
        registryOrigin: t.origin,
        authorization,
        headers: { ...t.session.baseHeaders, accept },
        method: 'HEAD',
        signal: t.signal,
        insecureHosts: t.session.insecureHosts,
        what: t.what,
      }),
  });
}

function upload(t: Target, method: 'POST' | 'PUT', url: string, body: Uint8Array<ArrayBuffer>, contentType?: string): Promise<FollowResult> {
  const headers: Record<string, string> = { ...t.session.baseHeaders };
  if (contentType !== undefined) headers['content-type'] = contentType;
  return authorizedRequest(t.session, {
    origin: t.origin,
    scope: pushScope(t.repository),
    what: t.what,
    signal: t.signal,
    denyInsufficientScope: true,
    send: (authorization) =>
      sendOnce(url, { fetch: t.session.fetch, registryOrigin: t.origin, authorization, headers, method, body, signal: t.signal, what: t.what }),
  });
}

/**
 * Uploads a blob unless the registry already holds it: `HEAD` the digest,
 * and when that is not a 200 with the same size, `POST` an upload session
 * and `PUT` the whole buffer to its `Location` with `?digest=`.
 */
export async function pushBlob(
  session: Session,
  ref: OciRepositoryRef,
  input: Uint8Array,
  options: { signal?: AbortSignal },
): Promise<OciPushedBlob> {
  const bytes = requireBytes(input, 'pushBlob() bytes');
  const origin = checkRepositoryRef(ref, session.insecureHosts);
  const digest = await digestOf(session, bytes);
  const size = bytes.byteLength;
  const t: Target = { session, origin, repository: ref.repository, what: `push blob ${digest} to ${ref.repository}`, signal: options.signal };

  const existing = await head(t, `${origin}/v2/${ref.repository}/blobs/${digest}`, '*/*');
  // A failure from the registry itself stops the push. A blob CDN the HEAD
  // was redirected to may refuse HEAD on a GET-signed URL; that only means
  // the existence check is inconclusive, so the blob is uploaded.
  const fromRegistry = new URL(existing.url).origin === origin;
  if (existing.response.status !== 404 && !existing.response.ok && fromRegistry) throw await pushFailure(existing.response, t.what);
  await existing.response.body?.cancel();
  if (existing.response.status === 200 && contentLength(existing.response) === size) return { digest, size };

  const startUrl = `${origin}/v2/${ref.repository}/blobs/uploads/`;
  const started = await upload(t, 'POST', startUrl, new Uint8Array(0));
  if (started.response.status !== 202) throw await pushFailure(started.response, `${t.what} (start upload)`);
  await started.response.body?.cancel();
  const location = started.response.headers.get('location');
  if (!location) throw new OciError('PROTOCOL', `${t.what}: upload session answered 202 without a Location`, { status: 202 });
  const putUrl = uploadTarget(location, started.url, origin, digest, t.what);

  const stored = await upload(t, 'PUT', putUrl, bytes, 'application/octet-stream');
  if (stored.response.status !== 201) throw await pushFailure(stored.response, t.what);
  await stored.response.body?.cancel();
  checkDigestHeader(stored.response, digest, t.what);
  return { digest, size };
}

/**
 * Checks the caller's manifest before anything is sent: it must be one of
 * the four manifest/index media types this package parses, structurally
 * valid, and its own `mediaType` field must equal `mediaType` (the field is
 * inside the digested bytes, the header is not).
 */
function checkManifestForPush(bytes: Uint8Array, mediaType: string): void {
  if (typeof mediaType !== 'string' || mediaType === '') throw new TypeError('@ifc-lite/oci: pushManifest() mediaType must be a non-empty string');
  let field: unknown;
  try {
    field = parseManifestDocument(bytes, null).mediaType;
  } catch (err) {
    throw new TypeError(`@ifc-lite/oci: pushManifest() manifest is not a valid manifest or index: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  if (field !== mediaType) {
    throw new TypeError(`@ifc-lite/oci: pushManifest() manifest declares mediaType "${String(field)}", not "${mediaType}"`);
  }
}

/**
 * Puts a manifest by tag (when `ref` has one) or by its digest. With a tag
 * and without `allowOverwrite`, an existing tag is `TAG_EXISTS`. That check
 * is a `HEAD` before the `PUT`, so it is not atomic: another client can
 * create the tag in between, and the `PUT` then overwrites it.
 */
export async function pushManifest(
  session: Session,
  ref: OciReference,
  input: Uint8Array,
  mediaType: string,
  options: OciPushManifestOptions,
): Promise<OciPushedManifest> {
  const bytes = requireBytes(input, 'pushManifest() manifest');
  checkManifestForPush(bytes, mediaType);
  const origin = checkRepositoryRef(ref, session.insecureHosts);
  if (ref.tag !== undefined || ref.digest !== undefined) manifestReference(ref);
  const digest = await digestOf(session, bytes);
  const reference = ref.tag ?? digest;
  const what = `push manifest ${ref.repository}:${reference}`;
  if (ref.digest !== undefined && ref.digest !== digest) {
    throw new OciError('DIGEST_MISMATCH', `${what}: reference pins ${ref.digest}, the manifest bytes hash to ${digest}`);
  }
  const t: Target = { session, origin, repository: ref.repository, what, signal: options.signal };
  const url = `${origin}/v2/${ref.repository}/manifests/${reference}`;

  if (ref.tag !== undefined && options.allowOverwrite !== true) {
    const accept = MANIFEST_ACCEPT.includes(mediaType) ? MANIFEST_ACCEPT : `${mediaType}, ${MANIFEST_ACCEPT}`;
    const current = await head(t, url, accept);
    if (current.response.status !== 200 && current.response.status !== 404) throw await pushFailure(current.response, `${what} (tag check)`);
    await current.response.body?.cancel();
    if (current.response.status === 200) {
      throw new OciError('TAG_EXISTS', `${what}: tag "${ref.tag}" already exists; pass allowOverwrite to replace it`, { status: 200 });
    }
  }

  const stored = await upload(t, 'PUT', url, bytes, mediaType);
  if (stored.response.status !== 201) throw await pushFailure(stored.response, what);
  await stored.response.body?.cancel();
  checkDigestHeader(stored.response, digest, what);
  return { digest };
}
