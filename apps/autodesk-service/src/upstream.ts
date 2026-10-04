/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const ORIGIN = 'https://developer.api.autodesk.com';
const PATHS = [
  /^\/authentication\/v2\/userinfo$/,
  /^\/project\/v1\/hubs(?:\/[^/]+\/projects(?:\/[^/]+\/topFolders)?)?$/,
  /^\/data\/v1\/projects\/[^/]+\/(?:folders\/[^/]+\/contents|items\/[^/]+(?:\/versions)?|versions\/[^/]+)$/,
  /^\/oss\/v2\/buckets\/[^/]+\/objects\/[^/]+\/signeds3download$/,
  /^\/forma\/site\/v1alpha\/sites\/[^/]+$/,
  /^\/forma\/proposal\/v1alpha\/proposals(?:\/[^/]+\/revisions)?$/,
  /^\/forma\/element-service\/v1alpha\/(?:elements|blobs)\/[^/]+$/,
];
export function apsUrl(path: string): string {
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || path.length > 32_768 ||
      !PATHS.some((pattern) => pattern.test(url.pathname))) throw new ServiceError(400, 'invalid-path', 'Unsupported Autodesk API operation.');
  return url.href;
}
export class ServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export async function apsResponse(fetcher: typeof fetch, path: string, token: string, region: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetcher(apsUrl(path), {
    headers: { Authorization: `Bearer ${token}`, 'X-Ads-Region': region },
    redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) {
    const status = [401, 403, 404, 429].includes(response.status) ? response.status : 502;
    throw new ServiceError(status, `upstream-${response.status}`, status === 403
      ? 'Autodesk denied access. Check project access, application provisioning and region.'
      : status === 401 ? 'Sign in with Autodesk again.' : 'The Autodesk request could not be completed.');
  }
  return response;
}
export function signedUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new ServiceError(502, 'invalid-download', 'Autodesk returned no download URL.');
  const url = new URL(raw);
  // Signed URLs never receive user credentials. Only known S3 origins may be followed.
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/(?:^|\.)s3(?:\.(?:us-west-2|us-east-1|eu-west-1|eu-central-1))?\.amazonaws\.com$/.test(url.hostname)) {
    throw new ServiceError(502, 'invalid-download', 'Autodesk returned an unconfigured download host.');
  }
  return url.href;
}
export async function downloadSigned(fetcher: typeof fetch, raw: unknown, signal?: AbortSignal): Promise<Response> {
  let url = signedUrl(raw);
  for (let count = 0; count < 5; count++) {
    const response = await fetcher(url, { redirect: 'manual', signal, credentials: 'omit' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      url = signedUrl(new URL(response.headers.get('location') ?? '', url).href);
      continue;
    }
    if (!response.ok) throw new ServiceError(502, 'download-failed', 'The model download failed. Retry to obtain a fresh signed link.');
    return response;
  }
  throw new ServiceError(502, 'redirect-limit', 'The model download redirected too many times.');
}
/** Bound streaming bytes, including responses without Content-Length. */
export function boundedResponse(response: Response, maxBytes: number, controller: AbortController): Response {
  const total = Number(response.headers.get('content-length'));
  if (Number.isFinite(total) && total > maxBytes) {
    controller.abort();
    void response.body?.cancel();
    throw new ServiceError(413, 'artifact-limit', 'The model exceeds this deployment’s configured download limit.');
  }
  if (!response.body) throw new ServiceError(502, 'empty-download', 'Autodesk returned an empty download.');
  let received = 0;
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, output) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        controller.abort();
        throw new ServiceError(413, 'artifact-limit', 'The model exceeds this deployment’s configured download limit.');
      }
      output.enqueue(chunk);
    },
  }));
  const headers = new Headers({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (response.headers.has('content-length')) headers.set('Content-Length', response.headers.get('content-length')!);
  return new Response(stream, { headers });
}
