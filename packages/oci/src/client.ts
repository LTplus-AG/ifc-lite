/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { pullScope, RegistryAuth } from './auth.js';
import { finishDigest, readBody } from './digest.js';
import { OciError, statusError } from './errors.js';
import { checkBlobRequest, readVerifiedBlob } from './fetch-blob.js';
import { MANIFEST_ACCEPT, parseManifestDocument } from './manifest-shape.js';
import { checkRepositoryRef, manifestReference } from './reference.js';
import { fetchFollowing, type FollowResult } from './transport.js';
import type {
  OciClientOptions,
  OciDescriptor,
  OciHasher,
  OciManifestResult,
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
 * Pull-only OCI distribution client: list tags, fetch a manifest, fetch a
 * digest-verified blob. Every request starts anonymous and authenticates
 * only when the registry answers 401 (see `RegistryAuth` for where
 * credentials may and may not go).
 */
export class OciClient {
  private readonly fetchFn: typeof fetch;
  private readonly auth: RegistryAuth;
  private readonly insecureHosts: readonly string[] | undefined;
  private readonly createHasher: (() => OciHasher) | undefined;
  private readonly maxManifestBytes: number;
  private readonly baseHeaders: Record<string, string>;

  constructor(options: OciClientOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.insecureHosts = options.insecureHosts;
    this.createHasher = options.createHasher;
    this.maxManifestBytes = positiveInteger(options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES, 'maxManifestBytes');
    this.baseHeaders = options.userAgent ? { 'user-agent': options.userAgent } : {};
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
    this.auth = new RegistryAuth({
      fetch: this.fetchFn,
      credentials: options.credentials,
      trustedRealms: trusted,
      insecureHosts: options.insecureHosts,
      baseHeaders: this.baseHeaders,
    });
  }

  /**
   * GET against the registry with the auth dance: anonymous (or a cached
   * token) first, then on 401 one authentication and one retry. A second 401
   * is `UNAUTHORIZED`; every other non-2xx is mapped by `statusError`.
   */
  private async get(origin: string, repository: string, url: string, accept: string, signal: AbortSignal | undefined, what: string): Promise<FollowResult> {
    const scope = pullScope(repository);
    let authorization = this.auth.cached(origin, scope);
    for (let attempt = 0; ; attempt++) {
      const result = await fetchFollowing(url, {
        fetch: this.fetchFn,
        registryOrigin: origin,
        authorization,
        headers: { ...this.baseHeaders, accept },
        signal,
        insecureHosts: this.insecureHosts,
        what,
      });
      const { response } = result;
      if (response.ok) return result;
      await response.body?.cancel();
      if (response.status !== 401) throw statusError(response.status, what);
      if (attempt > 0) {
        this.auth.invalidate(origin, scope);
        throw new OciError('UNAUTHORIZED', `${what}: still 401 after authenticating`, { status: 401 });
      }
      if (new URL(result.url).origin !== origin) {
        throw new OciError('UNAUTHORIZED', `${what}: redirect target ${new URL(result.url).origin} answered 401`, { status: 401 });
      }
      if (authorization !== undefined) this.auth.invalidate(origin, scope);
      authorization = await this.auth.authorize(origin, scope, response.headers.get('www-authenticate'), signal);
    }
  }

  /**
   * Lists every tag, following `Link: <...>; rel="next"` pagination. A
   * relative link resolves against the page URL; an absolute one must stay on
   * the registry origin. More than `maxPages` (default 100) pages is
   * `PROTOCOL`, as is a link that revisits a page.
   */
  async tags(ref: OciRepositoryRef, options: { signal?: AbortSignal; maxPages?: number } = {}): Promise<string[]> {
    const origin = checkRepositoryRef(ref, this.insecureHosts);
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
    const origin = checkRepositoryRef(ref, this.insecureHosts);
    const reference = manifestReference(ref);
    const what = `manifest ${ref.repository}${ref.digest ? `@${ref.digest}` : `:${reference}`}`;
    const url = `${origin}/v2/${ref.repository}/manifests/${reference}`;
    const { response } = await this.get(origin, ref.repository, url, MANIFEST_ACCEPT, options.signal, what);
    const hasher = this.createHasher?.();
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
    const origin = checkRepositoryRef(ref, this.insecureHosts);
    checkBlobRequest(descriptor, options.maxBytes);
    const what = `blob ${descriptor.digest}`;
    const url = `${origin}/v2/${ref.repository}/blobs/${descriptor.digest}`;
    const { response } = await this.get(origin, ref.repository, url, '*/*', options.signal, what);
    return readVerifiedBlob(response, descriptor, this.createHasher);
  }
}
