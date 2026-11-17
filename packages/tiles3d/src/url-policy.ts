/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which URLs the reader may request. A tileset can name any absolute URI for
 * its children, so by default only `http:` / `https:` are fetched and child
 * URIs must share the root tileset's origin. This is a policy on the URLs the
 * reader builds; it does not resolve DNS or follow redirects, which a
 * server-side caller must police in its own `fetch` (see the README).
 */

export interface UrlPolicyOptions {
  /**
   * URL schemes the reader may fetch, with the trailing colon. Default
   * `['http:', 'https:']`; `data:`, `file:` and the rest are refused unless
   * listed here.
   */
  allowedProtocols?: string[];
  /**
   * Origins child URIs (external tilesets and contents) may point at, besides
   * the root tileset's own origin, which is always allowed. `'*'` allows any
   * origin. Default: only the root's origin.
   */
  allowedOrigins?: string[] | '*';
}

export class UrlPolicyError extends Error {
  constructor(readonly url: string, reason: string) {
    super(`URL refused by the URL policy: ${reason}: ${url}`);
    this.name = 'UrlPolicyError';
  }
}

export class UrlPolicy {
  private readonly protocols: Set<string>;
  private readonly origins: Set<string> | '*';
  readonly rootOrigin: string;

  constructor(rootUrl: string, opts: UrlPolicyOptions = {}) {
    this.protocols = new Set((opts.allowedProtocols ?? ['http:', 'https:']).map((p) => p.toLowerCase()));
    let root: URL;
    try {
      root = new URL(rootUrl);
    } catch {
      throw new UrlPolicyError(rootUrl, 'not an absolute URL');
    }
    this.rootOrigin = root.origin;
    this.origins = opts.allowedOrigins === '*' ? '*' : new Set([root.origin, ...(opts.allowedOrigins ?? []).map(originOf)]);
    if (!this.protocols.has(root.protocol)) throw new UrlPolicyError(rootUrl, `protocol ${root.protocol} is not allowed`);
  }

  /** Throws `UrlPolicyError` when `url` may not be fetched as a child of the root. */
  check(url: string): void {
    const u = new URL(url);
    if (!this.protocols.has(u.protocol)) throw new UrlPolicyError(url, `protocol ${u.protocol} is not allowed`);
    if (this.origins !== '*' && !this.origins.has(u.origin)) {
      throw new UrlPolicyError(url, `origin ${u.origin} is not the root tileset's origin (${this.rootOrigin}) or in allowedOrigins`);
    }
  }
}

function originOf(o: string): string {
  try {
    return new URL(o).origin;
  } catch {
    throw new RangeError(`allowedOrigins entry ${o} is not an absolute URL or origin`);
  }
}
