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

/**
 * What an upload step's body is, per the Dalux Build API spec:
 * - `empty`: create slot. The spec defines no request body, so none is relayed.
 * - `bytes`: a file part, `application/octet-stream`, with `Content-Range` and
 *   `Content-Disposition`.
 * - `json`: finalize, an `application/json` file-metadata object.
 */
export type UploadBody = 'empty' | 'bytes' | 'json';

/** What an upload step must carry, beyond the API key. */
export interface UploadRoute {
  readonly pattern: RegExp;
  readonly body: UploadBody;
}

/**
 * The only paths POST is relayed to: Dalux's three-step file upload
 * (create slot, send part, finalize). Matched against the decoded, validated
 * path, anchored at both ends.
 */
export const UPLOAD_ROUTES: readonly UploadRoute[] = [
  { pattern: /^1\.0\/projects\/[^/]+\/file_areas\/[^/]+\/upload$/, body: 'empty' },
  { pattern: /^1\.0\/projects\/[^/]+\/file_areas\/[^/]+\/upload\/[^/]+$/, body: 'bytes' },
  {
    pattern: /^2\.0\/projects\/[^/]+\/file_areas\/[^/]+\/upload\/[^/]+\/finalize$/,
    body: 'json',
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

/** A part's declared byte range, parsed. */
interface PartRange {
  readonly start: number;
  readonly end: number;
  readonly total: number;
}

function parsePartRange(value: string | null): PartRange | null {
  const range = CONTENT_RANGE_PATTERN.exec(value ?? '');
  if (!range) return null;
  const start = Number(range[1]);
  const end = Number(range[2]);
  const total = Number(range[3]);
  if (end < start || end >= total) return null;
  return { start, end, total };
}

/** A refusal decided from headers alone. */
export interface UploadRefusal {
  readonly status: 400 | 413;
  readonly message: string;
}

/**
 * Header-only checks, run BEFORE the body is read so a malformed or oversized
 * request costs no buffering. Returns the refusal, or null.
 */
export function validateUploadHeaders(route: UploadRoute, request: Request): UploadRefusal | null {
  const bad = (message: string): UploadRefusal => ({ status: 400, message });
  const type = mediaType(request.headers.get('content-type'));
  const declared = request.headers.get('content-length');

  if (route.body === 'empty') {
    if (declared !== null && Number(declared) !== 0) {
      return bad('Creating an upload slot takes no request body');
    }
    return null;
  }
  if (route.body === 'json') {
    if (type !== 'application/json') {
      return bad('Finalizing an upload requires Content-Type application/json');
    }
    if (declared !== null && Number(declared) > MAX_RELAYED_BODY_BYTES) {
      return { status: 413, message: `Upload requests through this relay are limited to ${MAX_RELAYED_BODY_BYTES} bytes` };
    }
    return null;
  }

  if (type !== 'application/octet-stream') {
    return bad('A file part requires Content-Type application/octet-stream');
  }
  if (!request.headers.get('content-disposition')?.trim()) {
    return bad('A file part requires Content-Disposition with the file name');
  }
  const range = parsePartRange(request.headers.get('content-range'));
  if (!range) return bad('A file part requires Content-Range: bytes <start>-<end>/<total>');
  if (range.end - range.start + 1 > MAX_RELAYED_BODY_BYTES) {
    return { status: 413, message: `Upload parts through this relay are limited to ${MAX_RELAYED_BODY_BYTES} bytes` };
  }
  if (declared !== null && Number(declared) !== range.end - range.start + 1) {
    return bad('Content-Range does not match Content-Length');
  }
  return null;
}

/**
 * Body checks, once the bounded body has been read. Returns an error message,
 * or null when the request may be forwarded.
 */
export function validateUploadBody(route: UploadRoute, request: Request, body: Uint8Array): string | null {
  if (route.body === 'empty') {
    return body.byteLength === 0 ? null : 'Creating an upload slot takes no request body';
  }
  if (route.body === 'json') {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'Finalizing an upload requires a JSON object body';
      }
    } catch {
      return 'Finalizing an upload requires a JSON object body';
    }
    return null;
  }
  const range = parsePartRange(request.headers.get('content-range'));
  if (!range || range.end - range.start + 1 !== body.byteLength) {
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
    // An empty slot request is sent without a body, as the spec defines it.
    body: body.byteLength > 0 ? body : undefined,
    redirect: 'manual',
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Upstream redirected an upload (${response.status}); not following`);
  }
  return response;
}
