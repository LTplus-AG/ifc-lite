/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Autodesk Platform Services (APS) protocol handling for the `aps.*` flow
 * nodes (#5634): OAuth token acquisition and Model Derivative reads.
 *
 * The protocol knowledge is adapted, at the author's request, from the
 * author's own ifc-ai-rendering project (`lib/aps-auth.ts`,
 * `app/api/aps/{viewer-token,viewable,derivative/[urn]}`), which runs these
 * exact calls against live APS:
 *   - `POST /authentication/v2/token`, form-encoded, `grant_type=client_credentials`
 *     with `client_id`/`client_secret`/`scope` in the body;
 *   - the derivative URN is the Docs/ACC version id (or OSS object id),
 *     base64url-encoded without padding;
 *   - `GET /modelderivative/v2/designdata/{urn}/metadata`, picking the `3d`
 *     view, then `.../metadata/{guid}/properties`; `x-ads-region` selects the
 *     data centre.
 *
 * Every request goes through `coreNetworkRequest`, so the https-only /
 * exact-host-grant policy of `http.request` applies unchanged: a graph must
 * declare `network.fetch:developer.api.autodesk.com`.
 *
 * The access token never becomes a plain flow value. A token derived from a
 * client secret is not itself a secret the redaction map knows, so a string
 * output would print it in clear on `flow run` / `run_flow`. It travels as an
 * {@link ApsToken} handle instead: the bearer string lives in a module-private
 * `WeakMap`, invisible to `JSON.stringify`, `redactDeep`, digests and
 * inspectors, and every error message is scrubbed of it before it is thrown.
 */

import { coreNetworkRequest, type NetworkResponse } from '@ifc-lite/sandbox';
import type { Ctx } from './host.js';

export const APS_HOST = 'developer.api.autodesk.com';
const APS_BASE = `https://${APS_HOST}`;
export const APS_DEFAULT_SCOPE = 'data:read viewables:read';
export const APS_REGIONS = ['US', 'EMEA', 'AUS', 'CAN', 'DEU', 'IND', 'JPN', 'GBR'] as const;

const TOKEN_TIMEOUT_MS = 15_000;
const TOKEN_MAX_BYTES = 64 * 1024;

const bearerByHandle = new WeakMap<ApsToken, string>();

/**
 * An opaque APS access token. Only this module can read the bearer string;
 * serialising the handle yields its description, never the token.
 */
export class ApsToken {
  readonly kind = 'aps.token';

  constructor(
    bearer: string,
    /** `client_credentials` (2-legged, minted here) or `provided` (a 3-legged token passed in). */
    readonly grant: 'client_credentials' | 'provided',
    readonly scope: string,
    /** Epoch ms, when the token endpoint reported `expires_in`. */
    readonly expiresAt: number | null,
  ) {
    bearerByHandle.set(this, bearer);
  }

  toJSON(): Record<string, unknown> {
    return { kind: this.kind, grant: this.grant, scope: this.scope, expiresAt: this.expiresAt };
  }

  toString(): string {
    return `[APS token, ${this.grant}]`;
  }
}

function bearerOf(token: ApsToken): string {
  const bearer = bearerByHandle.get(token);
  // A handle that crossed a structured clone (worker, IPC) loses its bearer on purpose.
  if (bearer === undefined) throw new Error('APS token handle has no bearer (was it copied across a process or worker boundary?)');
  return bearer;
}

/** `aps.xxx: ` prefixed error, with every occurrence of `bearer` scrubbed. */
function apsError(node: string, message: string, bearer?: string): Error {
  const clean = bearer && bearer.length > 0 ? message.split(bearer).join('<aps-token>') : message;
  return new Error(`${node}: ${clean}`);
}

/** At most `max` characters of an APS error body, for a diagnosable message. */
function snippet(body: string, max = 300): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

interface ApsGetOptions {
  readonly region: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

async function send(
  ctx: Ctx, node: string, init: Parameters<typeof coreNetworkRequest>[0], bearer?: string,
): Promise<NetworkResponse> {
  try {
    return await coreNetworkRequest(init, ctx.host.networkGrants ?? [], ctx.host.networkTransport);
  } catch (err) {
    // Denials (ungranted host, redirect) and transport failures alike: prefix and scrub.
    throw apsError(node, err instanceof Error ? err.message : String(err), bearer);
  }
}

/**
 * A 2-legged token from the client-credentials grant. `clientSecret` is
 * normally a `{{secret:APS_CLIENT_SECRET}}` reference, already interpolated
 * by the CLI/MCP runner; it only ever travels in the request body.
 */
export async function requestClientToken(
  ctx: Ctx, node: string, clientId: string, clientSecret: string, scope: string,
): Promise<ApsToken> {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope }).toString();
  const res = await send(ctx, node, {
    url: `${APS_BASE}/authentication/v2/token`,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    timeoutMs: TOKEN_TIMEOUT_MS,
    maxBytes: TOKEN_MAX_BYTES,
    signal: ctx.signal,
  });
  if (res.status < 200 || res.status >= 300) {
    throw apsError(node, `token request failed (HTTP ${res.status}): ${snippet(res.body)}`);
  }
  let parsed: { access_token?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(res.body) as typeof parsed;
  } catch {
    throw apsError(node, 'token endpoint returned a non-JSON body');
  }
  if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
    throw apsError(node, 'token endpoint returned no access_token');
  }
  const expiresAt = typeof parsed.expires_in === 'number' ? Date.now() + parsed.expires_in * 1000 : null;
  return new ApsToken(parsed.access_token, 'client_credentials', scope, expiresAt);
}

/** Wrap a ready (typically 3-legged) access token without any request. */
export function providedToken(accessToken: string): ApsToken {
  return new ApsToken(accessToken, 'provided', '', null);
}

/** Authorised GET against the APS host; returns status and parsed-or-raw body. */
export async function apsGet(
  ctx: Ctx, node: string, token: ApsToken, path: string, opts: ApsGetOptions,
): Promise<{ status: number; body: string }> {
  const bearer = bearerOf(token);
  const res = await send(ctx, node, {
    url: `${APS_BASE}${path}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${bearer}`, 'x-ads-region': opts.region, Accept: 'application/json' },
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    signal: ctx.signal,
  }, bearer);
  if (res.truncated) {
    throw apsError(node, `response for ${path.split('?')[0]} exceeded maxBytes (${opts.maxBytes}); raise the node's maxBytes param`, bearer);
  }
  // The body is APS's, but scrub anyway: a proxy echoing the request must not leak the bearer.
  return { status: res.status, body: res.body.split(bearer).join('<aps-token>') };
}

/**
 * The Model Derivative URN for a model reference:
 *   - a raw `urn:adsk.…` id (a Docs/ACC version id such as
 *     `urn:adsk.wipprod:fs.file:vf.…?version=3`, or an OSS object id) is
 *     base64url-encoded without padding, as ifc-ai-rendering does;
 *   - an already-encoded URN (optionally `urn:`-prefixed, as the viewer
 *     writes it) is normalised to the base64url alphabet without padding.
 * A lineage (item) id names no version, so it is refused with a hint.
 */
export function toDerivativeUrn(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) throw new Error('a model URN is required');
  const body = value.startsWith('urn:') ? value.slice(4) : value;
  if (value.startsWith('urn:') && body.includes(':')) {
    if (body.includes(':dm.lineage:')) {
      throw new Error(`"${value}" is an item (lineage) id, not a version; pass the item's version id (…:fs.file:vf.…?version=N)`);
    }
    return base64Url(value);
  }
  if (!/^[A-Za-z0-9+/_=-]+$/.test(body)) throw new Error(`"${value}" is neither a urn:adsk… id nor a base64 derivative URN`);
  return body.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
export function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return signal?.aborted ? Promise.reject(new Error('cancelled')) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
