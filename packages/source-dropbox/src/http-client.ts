/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from '@ifc-lite/plugin-api';

const API_BASE_URL = 'https://api.dropboxapi.com/2';
const CONTENT_BASE_URL = 'https://content.dropboxapi.com/2';

/** Upstream response bodies are interpolated into thrown `Error` messages,
 * which reach user-facing toasts unmodified — cap them the same way
 * `source-msgraph`/`source-dalux` do. Never includes the request's own
 * `Authorization` header value, which never reaches this function in the
 * first place — `ctx.fetch` attaches it. */
const MAX_ERROR_BODY_CHARS = 200;

function truncate(text: string, max = MAX_ERROR_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Thrown for a non-2xx Dropbox API response. Carries the actual HTTP status
 * so callers can branch on it (auth-failure detection in `testConnection`)
 * rather than on substrings of the (possibly truncated) upstream error body. */
export class DropboxHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DropboxHttpError';
  }
}

export class BrowserDropboxApiClient {
  constructor(
    private readonly accessToken: string,
    private readonly ctx: PluginContext,
  ) {}

  debug(message: string, details?: Record<string, unknown>): void {
    this.ctx.log.debug(`Dropbox ${message}`, details ?? {});
  }

  /**
   * Calls one of Dropbox's JSON "RPC-style" endpoints (`api.dropboxapi.com`)
   * — every endpoint this provider uses *except* `files/download`, which
   * lives on a different host and passes its argument in a header instead of
   * the body (see {@link downloadContent}). Per Dropbox's own HTTP docs
   * ("RPC endpoints", `www.dropbox.com/developers/documentation/http/documentation`):
   * these endpoints are `POST` with a JSON request body and
   * `Content-Type: application/json`; an endpoint that takes no arguments
   * (`users/get_current_account`) still expects a body — the JSON literal
   * `null` — not an empty body.
   */
  async rpc(path: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const url = `${API_BASE_URL}${path}`;
    this.debug('RPC request', { url });
    const response = await this.ctx.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args ?? null),
      signal,
    });
    this.debug('RPC response', { url, status: response.status, ok: response.ok });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.ctx.log.error('Dropbox RPC failed', { url, status: response.status, body });
      throw new DropboxHttpError(`Dropbox ${response.status}: ${response.statusText} — ${truncate(body)}`, response.status);
    }

    return response.json() as Promise<unknown>;
  }

  /**
   * Fetches file bytes from `files/download` on `content.dropboxapi.com`.
   *
   * Per Dropbox's HTTP docs ("Content-upload and content-download endpoints"):
   * these endpoints take their arguments in a `Dropbox-API-Arg` request
   * header, JSON-encoded, rather than in the request body (the body carries
   * the raw uploaded/downloaded bytes instead). `path` is either a
   * `path_lower`, an opaque Dropbox `id`, or, for a historical revision, the
   * literal string `"rev:<rev-id>"` — see the citation on `download()` in
   * `provider.ts`.
   *
   * Sending a custom header (`Dropbox-API-Arg`, on top of `Authorization`)
   * makes this a CORS "non-simple" request, which triggers a browser
   * preflight `OPTIONS` round trip before the real `POST` — costing latency,
   * *not* failing: Dropbox's API does send `Access-Control-Allow-Origin` /
   * `Access-Control-Allow-Headers` on that preflight (confirmed via the
   * Dropbox JS SDK's own issue tracker discussing exactly this preflight
   * overhead, `github.com/dropbox/dropbox-sdk-js` issue #111, and Dropbox
   * support threads on `Access-Control-Allow-Origin`, checked 2026-08-15).
   * This is the opposite failure mode from Microsoft Graph's `/content`
   * endpoint (a `302` redirect a CORS preflight can't follow at all,
   * documented on `download()` in `source-msgraph`'s `provider.ts`) — Dropbox
   * genuinely answers the authenticated request directly with no redirect, so
   * there is no pre-signed-URL indirection to build here and no need for
   * `ctx.fetchPublic`/`publicNetwork` at all.
   */
  async downloadContent(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const url = `${CONTENT_BASE_URL}/files/download`;
    this.debug('content download request', { url, path });
    const response = await this.ctx.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path }),
      },
      signal,
    });
    this.debug('content download response', { url, status: response.status, ok: response.ok });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.ctx.log.error('Dropbox download failed', { url, status: response.status, body });
      throw new DropboxHttpError(`Dropbox download ${response.status}: ${response.statusText} — ${truncate(body)}`, response.status);
    }

    return response.arrayBuffer();
  }
}
