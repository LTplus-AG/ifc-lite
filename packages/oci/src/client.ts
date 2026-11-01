/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { pullScope, RegistryAuth } from './auth.js';
import { EMPTY_CONFIG_DIGEST, EMPTY_CONFIG_MEDIA_TYPE, emptyConfigBytes } from './build-manifest.js';
import { finishDigest, readBody } from './digest.js';
import { OciError, statusError } from './errors.js';
import { checkBlobRequest, readVerifiedBlob } from './fetch-blob.js';
import { MANIFEST_ACCEPT, parseManifestDocument } from './manifest-shape.js';
import { pushBlob, pushManifest } from './push.js';
import { checkRepositoryRef, manifestReference } from './reference.js';
import { authorizedRequest, type Session } from './session.js';
import { fetchFollowing, type FollowResult } from './transport.js';
import type {
  OciClientOptions,
  OciDescriptor,
  OciManifestResult,
  OciPushedBlob,
  OciPushedManifest,
  OciPushManifestOptions,
  OciReference,
  OciRepositoryRef,
} from './types.js';

const DEFAULT_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_TAG_PAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TAG_PAGES = 100;

/** Returns the `rel="next"` target of a `Link` header, unresolved. */
function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  const pattern = /<([^>]*)>((?:\s*;\s*[^;,]*)*)/g;
  for (const match of header.matchAll(pattern)) {
    const params = match[2];
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(params);
    const value = rel ? rel[1] ?? rel[2] : undefined;
    if (value && value.toLowerCase().split(/\s+/).includes('next')) return match[1];
  }
  return undefined;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`@ifc-lite/oci: ${name} must be a positive integer`);
  return value;
}

/**
 * OCI distribution client: list tags, fetch a manifest, fetch a
 * digest-verified blob, and push blobs and manifests. Every request starts
 * anonymous and authenticates only when the registry answers 401 (see
 * `RegistryAuth` for where credentials may and may not go). Pulls ask for
 * `repository:<repo>:pull`, pushes for `repository:<repo>:pull,push`; tokens
 * are cached per scope, so the two never share one.
 */
export class OciClient {
  private readonly session: Session;
  private readonly maxManifestBytes: number;

  constructor(options: OciClientOptions = {}) {
    const fetchFn: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.maxManifestBytes = positiveInteger(options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES, 'maxManifestBytes');
    const baseHeaders: Record<string, string> = options.userAgent ? { 'user-agent': options.userAgent } : {};
    const trusted = new Set<string>();
    for (const realm of options.trustedRealms ?? []) {
      let url: URL;
      try {
        url = new URL(realm);
      } catch (err) {
        throw new TypeError(`@ifc-lite/oci: trustedRealms entry "${realm}" is not a URL`, { cause: err });
      }
      trusted.add(url.origin);
    }
    const auth = new RegistryAuth({
      fetch: fetchFn,
      credentials: options.credentials,
      trustedRealms: trusted,
      insecureHosts: options.insecureHosts,
      baseHeaders,
    });
    this.session = { fetch: fetchFn, auth, insecureHosts: options.insecureHosts, baseHeaders, createHasher: options.createHasher };
  }

  /**
   * GET against the registry with the auth dance (`authorizedRequest`); every
   * non-2xx other than the handled 401 is mapped by `statusError`.
   */
  private async get(origin: string, repository: string, url: string, accept: string, signal: AbortSignal | undefined, what: string): Promise<FollowResult> {
    const { session } = this;
    const result = await authorizedRequest(session, {
      origin,
      scope: pullScope(repository),
      what,
      signal,
      send: (authorization) =>
        fetchFollowing(url, {
          fetch: session.fetch,
          registryOrigin: origin,
          authorization,
          headers: { ...session.baseHeaders, accept },
          signal,
          insecureHosts: session.insecureHosts,
          what,
        }),
    });
    if (result.response.ok) return result;
    await result.response.body?.cancel();
    throw statusError(result.response.status, what);
  }

  /**
   * Lists every tag, following `Link: <...>; rel="next"` pagination. A
   * relative link resolves against the page URL; an absolute one must stay on
   * the registry origin. More than `maxPages` (default 100) pages is
   * `PROTOCOL`, as is a link that revisits a page.
   */
  async tags(ref: OciRepositoryRef, options: { signal?: AbortSignal; maxPages?: number } = {}): Promise<string[]> {
    const origin = checkRepositoryRef(ref, this.session.insecureHosts);
    const maxPages = positiveInteger(options.maxPages ?? DEFAULT_MAX_TAG_PAGES, 'maxPages');
    const what = `tags of ${ref.repository}`;
    const out: string[] = [];
    const seen = new Set<string>();
    let url = `${origin}/v2/${ref.repository}/tags/list`;
    for (let page = 1; ; page++) {
      seen.add(url);
      const { response } = await this.get(origin, ref.repository, url, 'application/json', options.signal, what);
      const bytes = await readBody(response, { cap: MAX_TAG_PAGE_BYTES, what });
      let doc: unknown;
      try {
        doc = JSON.parse(new TextDecoder().decode(bytes));
      } catch (err) {
        throw new OciError('PROTOCOL', `${what}: tag list is not JSON`, { cause: err });
      }
      const tags = typeof doc === 'object' && doc !== null ? (doc as { tags?: unknown }).tags : undefined;
      if (tags !== null && tags !== undefined) {
        if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
          throw new OciError('PROTOCOL', `${what}: "tags" is not an array of strings`);
        }
        out.push(...(tags as string[]));
      }
      const link = nextLink(response.headers.get('link'));
      if (link === undefined) return out;
      let next: URL;
      try {
        next = new URL(link, url);
      } catch (err) {
        throw new OciError('PROTOCOL', `${what}: unparseable Link next URL`, { cause: err });
      }
      if (next.origin !== origin) throw new OciError('PROTOCOL', `${what}: Link next points to another origin (${next.origin})`);
      if (seen.has(next.href)) throw new OciError('PROTOCOL', `${what}: Link next revisits a page already read`);
      if (page >= maxPages) throw new OciError('PROTOCOL', `${what}: more than ${maxPages} pages`);
      url = next.href;
    }
  }

  /**
   * Fetches a manifest or index by digest (preferred when both are present)
   * or tag. The digest is always computed from the received bytes; it must
   * equal `ref.digest` when the reference pins one, and a
   * `Docker-Content-Digest` header, when the registry sends one, is checked
   * as well (its absence is fine: some registries omit it).
   */
  async manifest(ref: OciReference, options: { signal?: AbortSignal } = {}): Promise<OciManifestResult> {
    const origin = checkRepositoryRef(ref, this.session.insecureHosts);
    const reference = manifestReference(ref);
    const what = `manifest ${ref.repository}${ref.digest ? `@${ref.digest}` : `:${reference}`}`;
    const url = `${origin}/v2/${ref.repository}/manifests/${reference}`;
    const { response } = await this.get(origin, ref.repository, url, MANIFEST_ACCEPT, options.signal, what);
    const hasher = this.session.createHasher?.();
    const bytes = await readBody(response, {
      cap: this.maxManifestBytes,
      what,
      onChunk: hasher ? (chunk) => hasher.update(chunk) : undefined,
    });
    const digest = await finishDigest(bytes, hasher);
    if (ref.digest !== undefined && ref.digest !== digest) {
      throw new OciError('DIGEST_MISMATCH', `${what}: received bytes hash to ${digest}`);
    }
    const header = response.headers.get('docker-content-digest');
    if (header !== null && header.trim() !== digest) {
      throw new OciError('DIGEST_MISMATCH', `${what}: Docker-Content-Digest ${header.trim()} does not match received bytes (${digest})`);
    }
    const value = parseManifestDocument(bytes, response.headers.get('content-type'));
    return { digest, mediaType: value.mediaType, bytes, value };
  }

  /**
   * Fetches a blob and verifies it against `descriptor`: exactly
   * `descriptor.size` bytes (never more than `maxBytes`) hashing to
   * `descriptor.digest`. Redirects (registries hand blobs to a CDN) are
   * followed without `Authorization`.
   */
  async blob(ref: OciReference, descriptor: OciDescriptor, options: { signal?: AbortSignal; maxBytes: number }): Promise<Uint8Array> {
    const origin = checkRepositoryRef(ref, this.session.insecureHosts);
    checkBlobRequest(descriptor, options.maxBytes);
    const what = `blob ${descriptor.digest}`;
    const url = `${origin}/v2/${ref.repository}/blobs/${descriptor.digest}`;
    const { response } = await this.get(origin, ref.repository, url, '*/*', options.signal, what);
    return readVerifiedBlob(response, descriptor, this.session.createHasher);
  }

  /**
   * Uploads `bytes` as a blob and returns its digest and size. When the
   * registry already holds a blob with that digest and size, nothing is
   * uploaded. Otherwise a monolithic upload: `POST /blobs/uploads/`, then
   * one `PUT` of the whole buffer to the returned `Location` (same origin
   * only) with `?digest=`. A `Docker-Content-Digest` reply must match.
   */
  pushBlob(ref: OciRepositoryRef, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<OciPushedBlob> {
    return pushBlob(this.session, ref, bytes, options);
  }

  /**
   * Uploads the OCI empty config blob (`{}`, 2 bytes) that
   * `buildImageManifest` references by default, and returns its descriptor.
   */
  async pushEmptyConfig(ref: OciRepositoryRef, options: { signal?: AbortSignal } = {}): Promise<OciDescriptor> {
    const { digest, size } = await pushBlob(this.session, ref, emptyConfigBytes(), options);
    if (digest !== EMPTY_CONFIG_DIGEST) throw new OciError('DIGEST_MISMATCH', `empty config hashed to ${digest}`);
    return { mediaType: EMPTY_CONFIG_MEDIA_TYPE, digest, size };
  }

  /**
   * Pushes a manifest or index whose own `mediaType` field equals
   * `mediaType`, by `ref.tag` when present, else by its digest (a pinned
   * `ref.digest` must match). Without `allowOverwrite`, an existing tag is
   * `TAG_EXISTS`; that check runs before the `PUT` and is not atomic.
   * Every blob the manifest names must already be in the repository.
   */
  pushManifest(ref: OciReference, manifest: Uint8Array, mediaType: string, options: OciPushManifestOptions = {}): Promise<OciPushedManifest> {
    return pushManifest(this.session, ref, manifest, mediaType, options);
  }
}
