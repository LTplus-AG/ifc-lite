/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Dalux relay's one write path: the three-step file upload (#9522).
 *
 * `dalux-relay.ts` stays read-only for every other endpoint. This module owns
 * which paths may be POSTed to, what each step must carry, how large a relayed
 * part may be, and how the request is sent upstream.
 */

/** What an upload step must carry, beyond the API key. */
export interface UploadRoute {
  readonly pattern: RegExp;
  /** Exact media type the request body must declare. */
  readonly contentType: 'application/json' | 'application/octet-stream';
  /** A part upload must declare its byte range and file name (Dalux spec). */
  readonly isPart: boolean;
}

/**
 * The only paths POST is relayed to: Dalux's three-step file upload
 * (create slot, send part, finalize). Matched against the decoded, validated
 * path, anchored at both ends.
 */
export const UPLOAD_ROUTES: readonly UploadRoute[] = [
  {
    pattern: /^1\.0\/projects\/[^/]+\/file_areas\/[^/]+\/upload$/,
    contentType: 'application/json',
    isPart: false,
  },
  {
    pattern: /^1\.0\/projects\/[^/]+\/file_areas\/[^/]+\/upload\/[^/]+$/,
    contentType: 'application/octet-stream',
    isPart: true,
  },
  {
    pattern: /^2\.0\/projects\/[^/]+\/file_areas\/[^/]+\/upload\/[^/]+\/finalize$/,
    contentType: 'application/json',
    isPart: false,
  },
];

/**
 * Largest request body relayed upstream. Vercel caps a function's request
 * body at 4.5 MB; staying at 4 MiB leaves room for headers. Dalux accepts
 * parts up to 100 MiB, so a provider going through this relay must split
 * uploads into parts no larger than this.
 */
export const MAX_RELAYED_BODY_BYTES = 4 * 1024 * 1024;

/** `bytes <start>-<end>/<total>`, as the Dalux part endpoint requires. */
export const CONTENT_RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(\d+)$/;

/** Extra request headers forwarded on an upload POST only. */
export const FORWARDED_UPLOAD_HEADERS = ['content-type', 'content-range', 'content-disposition'];

/** The upload route a decoded, validated path matches, if any. */
export function uploadRouteFor(upstreamPath: string): UploadRoute | undefined {
  const decoded = upstreamPath.split('/').map((segment) => decodeURIComponent(segment)).join('/');
  return UPLOAD_ROUTES.find((route) => route.pattern.test(decoded));
}

/** Media type without parameters, lower-cased. */
export function mediaType(value: string | null): string {
  return (value ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * Reads at most `limit` bytes of the request body. Returns null when the body
 * is larger, without buffering the excess.
 */
export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) return null;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Checks an upload request's headers and body against its route. Returns an
 * error message, or null when the request may be forwarded.
 */
export function validateUpload(route: UploadRoute, request: Request, body: Uint8Array): string | null {
  if (mediaType(request.headers.get('content-type')) !== route.contentType) {
    return `This upload step requires Content-Type ${route.contentType}`;
  }
  if (!route.isPart) {
    try {
      JSON.parse(new TextDecoder().decode(body));
    } catch {
      return 'This upload step requires a JSON body';
    }
    return null;
  }

  if (!request.headers.get('content-disposition')?.trim()) {
    return 'A file part requires Content-Disposition with the file name';
  }
  const range = CONTENT_RANGE_PATTERN.exec(request.headers.get('content-range') ?? '');
  if (!range) return 'A file part requires Content-Range: bytes <start>-<end>/<total>';
  const start = Number(range[1]);
  const end = Number(range[2]);
  const total = Number(range[3]);
  if (end < start || end >= total || end - start + 1 !== body.byteLength) {
    return 'Content-Range does not match the part body';
  }
  return null;
}

/**
 * POSTs an upload step. Redirects are never followed: re-sending a body to
 * another URL is not something an upload should do silently, and a 3xx would
 * otherwise reach the browser without its Location. A redirect is reported as
 * a failure instead.
 */
export async function sendUpload(
  fetchImpl: typeof fetch,
  target: URL,
  headers: Headers,
  body: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  const response = await fetchImpl(target.toString(), {
    method: 'POST',
    headers,
    body,
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Upstream redirected an upload (${response.status}); not following`);
  }
  return response;
}
