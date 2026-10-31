/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseChallenges, type RegistryAuth } from './auth.js';
import { OciError, statusError } from './errors.js';
import type { FollowResult } from './transport.js';
import type { OciHasher } from './types.js';

/** What every registry operation shares; built once by `OciClient`. */
export interface Session {
  fetch: typeof fetch;
  auth: RegistryAuth;
  insecureHosts: readonly string[] | undefined;
  baseHeaders: Record<string, string>;
  createHasher: (() => OciHasher) | undefined;
}

export interface AuthorizedRequest {
  origin: string;
  /** Token scope, e.g. `repository:<repo>:pull` or `repository:<repo>:pull,push`. */
  scope: string;
  what: string;
  signal: AbortSignal | undefined;
  /**
   * When true, a 401 after authenticating that names `DENIED` in its error
   * body, or `error="insufficient_scope"` in its challenge, is `DENIED`
   * rather than `UNAUTHORIZED`: the credentials worked, the grant did not.
   */
  denyInsufficientScope?: boolean;
  /** Sends the request once with the given `Authorization` (or none). */
  send(authorization: string | undefined): Promise<FollowResult>;
}

/**
 * Runs `send` with the auth dance: anonymous (or a cached token) first, then
 * on 401 one authentication and one retry. Returns the first non-401 result
 * with its body unread; a second 401 throws.
 */
export async function authorizedRequest(session: Session, request: AuthorizedRequest): Promise<FollowResult> {
  const { origin, scope, what, signal } = request;
  let authorization = session.auth.cached(origin, scope);
  for (let attempt = 0; ; attempt++) {
    const result = await request.send(authorization);
    const { response } = result;
    if (response.status !== 401) return result;
    if (attempt > 0) {
      session.auth.invalidate(origin, scope);
      if (request.denyInsufficientScope) {
        const { codes } = await readRegistryErrors(response);
        const challenge = parseChallenges(response.headers.get('www-authenticate') ?? '');
        const insufficient = challenge.some((c) => c.params.error === 'insufficient_scope');
        if (insufficient || codes.includes('DENIED')) {
          throw new OciError('DENIED', `${what}: registry denied access with the issued credentials (401, ${scope})`, { status: 401 });
        }
      } else {
        await response.body?.cancel();
      }
      throw new OciError('UNAUTHORIZED', `${what}: still 401 after authenticating`, { status: 401 });
    }
    await response.body?.cancel();
    if (new URL(result.url).origin !== origin) {
      throw new OciError('UNAUTHORIZED', `${what}: redirect target ${new URL(result.url).origin} answered 401`, { status: 401 });
    }
    if (authorization !== undefined) session.auth.invalidate(origin, scope);
    authorization = await session.auth.authorize(origin, scope, response.headers.get('www-authenticate'), signal);
  }
}

const MAX_ERROR_BODY_BYTES = 64 * 1024;

async function readPrefix(response: Response, cap: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done) return { text: decode(chunks), truncated: false };
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel();
  return { text: decode(chunks), truncated: true };
}

function decode(chunks: Uint8Array[]): string {
  const decoder = new TextDecoder();
  let out = '';
  for (const chunk of chunks) out += decoder.decode(chunk, { stream: true });
  return out + decoder.decode();
}

/**
 * Reads the `errors[].code` list of a distribution error body (at most 64
 * KiB). A body that is not a JSON error document has no codes; `detail`
 * then says why, so the caller's message still explains what came back.
 */
export async function readRegistryErrors(response: Response): Promise<{ codes: string[]; detail?: string }> {
  const { text, truncated } = await readPrefix(response, MAX_ERROR_BODY_BYTES);
  if (text.trim() === '') return { codes: [] };
  if (truncated) return { codes: [], detail: 'error body larger than 64 KiB, not parsed' };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { codes: [], detail: `error body is not JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const errors = typeof doc === 'object' && doc !== null ? (doc as { errors?: unknown }).errors : undefined;
  if (!Array.isArray(errors)) return { codes: [], detail: 'error body has no "errors" array' };
  const codes: string[] = [];
  for (const entry of errors) {
    const code = typeof entry === 'object' && entry !== null ? (entry as { code?: unknown }).code : undefined;
    if (typeof code === 'string') codes.push(code);
  }
  return { codes };
}

/**
 * Maps a failed push response to an error, consuming its body: the
 * distribution error codes are appended to the message, and a registry that
 * rejects the digest (`DIGEST_INVALID`) is `DIGEST_MISMATCH`.
 */
export async function pushFailure(response: Response, what: string): Promise<OciError> {
  const { status } = response;
  const { codes, detail } = await readRegistryErrors(response);
  const suffix = codes.length > 0 ? ` (registry error: ${codes.join(', ')})` : detail ? ` (${detail})` : '';
  if (codes.includes('DIGEST_INVALID')) {
    return new OciError('DIGEST_MISMATCH', `${what}: registry rejected the digest${suffix}`, { status });
  }
  const base = statusError(status, what);
  return new OciError(base.code, `${base.message}${suffix}`, { status });
}
