/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Room-admin HTTP routes: revoke a link, kick a peer, release an unused
 * fresh-room claim. Each requires an `admin` room token for the room it acts
 * on, sent as `Authorization: Bearer`. Token signing and verification and the
 * mint route live in `room-token.ts`.
 */

import type * as http from 'node:http';
import {
  bearerToken,
  isIllFormedRoomId,
  readJsonBody,
  verifyRoomToken,
  type RoomTokenClaims,
  type SecretResolver,
} from './room-token.js';

// ── HTTP revoke route ────────────────────────────────────────────────────────

export interface RevokeRequestBody {
  /** The share token to invalidate. */
  token: string;
}

export interface RevokeEndpointOptions {
  /** Secret used to verify the target + bearer tokens. */
  secret: SecretResolver;
  /** Add a `jti` to the server's deny-list. The authenticator's `isRevoked`
   *  should consult the same store so future joins with this token are rejected.
   *  `exp` is the revoked token's expiry (seconds since epoch) when known —
   *  stores use it to prune deny-list entries once the token would have
   *  expired on its own. */
  recordRevocation: (jti: string, room: string, exp?: number) => void | Promise<void>;
  /** Deny-list check — a bearer whose own `jti` was revoked (e.g. a kicked
   *  admin) must not be able to keep revoking other people's links. */
  isRevoked?: (jti: string) => boolean | Promise<boolean>;
  allowOrigin?: string;
  maxBodyBytes?: number;
  now?: () => number;
}

/**
 * Handle `POST /collab/revoke` (and its CORS preflight). The caller must
 * present an `admin` bearer token for the same room as the token being revoked.
 * Returns `true` when this route matched (and a response was sent).
 */
export async function handleRevokeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: RevokeEndpointOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/collab/revoke') return false;

  const allowOrigin = opts.allowOrigin ?? '*';
  const cors = {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method-not-allowed' }));
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req, opts.maxBodyBytes ?? 4096);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'bad-request';
    res.writeHead(reason === 'body-too-large' ? 413 : 400, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: reason }));
    return true;
  }

  const target = verifyRoomToken((body as Partial<RevokeRequestBody>)?.token ?? '', {
    secret: opts.secret,
    now: opts.now,
  });
  if (!target) {
    res.writeHead(400, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid-token' }));
    return true;
  }

  // Only a non-revoked admin token for the *same room* may revoke.
  const bearer = verifyRoomToken(bearerToken(req) ?? '', {
    secret: opts.secret,
    room: target.room,
    now: opts.now,
  });
  if (
    !bearer ||
    bearer.role !== 'admin' ||
    (opts.isRevoked && (await opts.isRevoked(bearer.jti)))
  ) {
    res.writeHead(403, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return true;
  }

  await opts.recordRevocation(target.jti, target.room, target.exp);
  res.writeHead(200, { ...cors, 'content-type': 'application/json' });
  res.end(JSON.stringify({ revoked: true, jti: target.jti }));
  return true;
}

// ── HTTP kick route ──────────────────────────────────────────────────────────

export interface KickRequestBody {
  roomId: string;
  /** Awareness clientId of the peer to disconnect. */
  clientId: number;
}

export interface KickEndpointOptions {
  /** Secret used to verify the admin bearer token. */
  secret: SecretResolver;
  /** Force-disconnect a peer by awareness clientId; returns whether one matched. */
  kick: (roomId: string, clientId: number) => boolean | Promise<boolean>;
  /** Deny-list check — a bearer whose own `jti` was revoked (e.g. an admin who
   *  was themselves kicked) must not be able to keep kicking peers. */
  isRevoked?: (jti: string) => boolean | Promise<boolean>;
  allowOrigin?: string;
  maxBodyBytes?: number;
  now?: () => number;
}

/**
 * Handle `POST /collab/kick` (and its CORS preflight). The caller must present
 * an `admin` bearer token for the target room. Returns `true` when this route
 * matched (and a response was sent).
 */
export async function handleKickRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: KickEndpointOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/collab/kick') return false;

  const allowOrigin = opts.allowOrigin ?? '*';
  const cors = {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method-not-allowed' }));
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req, opts.maxBodyBytes ?? 4096);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'bad-request';
    res.writeHead(reason === 'body-too-large' ? 413 : 400, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: reason }));
    return true;
  }

  const reqBody = body as Partial<KickRequestBody>;
  if (typeof reqBody?.roomId !== 'string' || !reqBody.roomId || typeof reqBody.clientId !== 'number') {
    res.writeHead(400, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid-request' }));
    return true;
  }

  const bearer = verifyRoomToken(bearerToken(req) ?? '', {
    secret: opts.secret,
    room: reqBody.roomId,
    now: opts.now,
  });
  if (
    !bearer ||
    bearer.role !== 'admin' ||
    (opts.isRevoked && (await opts.isRevoked(bearer.jti)))
  ) {
    res.writeHead(403, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return true;
  }

  const kicked = await opts.kick(reqBody.roomId, reqBody.clientId);
  res.writeHead(200, { ...cors, 'content-type': 'application/json' });
  res.end(JSON.stringify({ kicked }));
  return true;
}

// ── HTTP release route (#6581) ──────────────────────────────────────────────

export interface ReleaseRequestBody {
  /** The room whose unused claim is handed back. */
  roomId: string;
}

/** What a release request did: see `ReleaseEndpointOptions.release`. */
export type ReleaseResult = 'released' | 'in-use' | 'not-holder' | 'busy';

export interface ReleaseEndpointOptions {
  /** Secret used to verify the bearer token. */
  secret: SecretResolver;
  /**
   * Hand back the claim on `claims.room`. Called only with the verified,
   * unrevoked claims of an `admin` bearer for the requested room. Returns
   * `released` when the claim was still unused and the bearer is one of the
   * tokens minted for it, `in-use` when the room was joined or holds data,
   * `busy` when the server will not take more revocations now (the claim is
   * kept), and `not-holder` otherwise.
   */
  release: (claims: RoomTokenClaims) => ReleaseResult | Promise<ReleaseResult>;
  /** Deny-list check: a revoked bearer cannot release. */
  isRevoked?: (jti: string) => boolean | Promise<boolean>;
  allowOrigin?: string;
  maxBodyBytes?: number;
  now?: () => number;
}

/**
 * Handle `POST /collab/release` (and its CORS preflight). A client that
 * minted a fresh room's admin token and then failed to create the room (seed
 * preparation or the join failed) hands the claim back, freeing its slot in
 * the claim allowance. Body `{ roomId }`. Responds 200 `{ released: true }`,
 * 409 `room-in-use` for a room that was joined or holds data, 503 `busy`
 * when the claim is kept to bound the deny-list, 403 otherwise.
 */
export async function handleReleaseRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ReleaseEndpointOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/collab/release') return false;

  const cors = {
    'access-control-allow-origin': opts.allowOrigin ?? '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
  const reply = (status: number, body: Record<string, unknown>) => {
    res.writeHead(status, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return true;
  }
  if (req.method !== 'POST') return reply(405, { error: 'method-not-allowed' });

  let body: unknown;
  try {
    body = await readJsonBody(req, opts.maxBodyBytes ?? 4096);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'bad-request';
    return reply(reason === 'body-too-large' ? 413 : 400, { error: reason });
  }
  const roomId = (body as Partial<ReleaseRequestBody>)?.roomId;
  if (typeof roomId !== 'string' || !roomId || isIllFormedRoomId(roomId)) return reply(400, { error: 'invalid-request' });

  const bearer = verifyRoomToken(bearerToken(req) ?? '', { secret: opts.secret, room: roomId, now: opts.now });
  if (!bearer || bearer.role !== 'admin' || (opts.isRevoked && (await opts.isRevoked(bearer.jti)))) {
    return reply(403, { error: 'forbidden' });
  }
  const result = await opts.release(bearer);
  if (result === 'released') return reply(200, { released: true, roomId });
  if (result === 'in-use') return reply(409, { error: 'room-in-use' });
  if (result === 'busy') return reply(503, { error: 'busy' });
  return reply(403, { error: 'forbidden' });
}
