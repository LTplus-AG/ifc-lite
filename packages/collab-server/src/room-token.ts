/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Room tokens — accountless, link-based access control (plan §3).
 *
 * Sharing is a signed capability, not an account: a short JWT (HS256, a
 * server-held secret) carries the room id and the granted role
 * (`viewer` / `commenter` / `editor` / `admin`). Anyone with the link
 * presents the token as `?token=` on connect; the server verifies the
 * signature + expiry and derives the `Principal.role` from it. The display
 * identity (handle / color) travels separately over awareness — the token
 * collects no PII.
 *
 * HS256 is implemented directly on `node:crypto` so the reference server
 * needs no JWT dependency. `kid` supports key rotation ("revoke all links"
 * rotates the active key); `jti` supports single-link revocation via an
 * `isRevoked` deny-list.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type * as http from 'node:http';
import type { AuthenticateFn, Principal, Role } from './auth.js';

const VALID_ROLES: ReadonlySet<string> = new Set([
  'viewer',
  'commenter',
  'editor',
  'admin',
]);

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const DEFAULT_CLOCK_TOLERANCE_SEC = 30;

export interface RoomTokenClaims {
  /** Room id this token grants access to. */
  room: string;
  /** Granted access role. */
  role: Role;
  /** Issued-at (seconds since epoch). */
  iat: number;
  /** Expiry (seconds since epoch). */
  exp: number;
  /** Unique token id — enables single-link revocation. */
  jti: string;
  /** Key id (for rotation). Mirrors the JWS header `kid`. */
  kid?: string;
}

/** Resolve a secret, optionally by `kid`, for verification (key rotation). */
export type SecretResolver = string | ((kid: string | undefined) => string | undefined);

function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBuffer(input: string): Buffer {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, 'base64');
}

function hmac(signingInput: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(signingInput).digest();
}

function resolveSecret(secret: SecretResolver, kid: string | undefined): string | undefined {
  return typeof secret === 'function' ? secret(kid) : secret;
}

export interface SignRoomTokenOptions {
  roomId: string;
  role: Role;
  /** Signing secret (must match the verifier's secret for this `kid`). */
  secret: string;
  /** Token lifetime in seconds (default 7 days). */
  ttlSeconds?: number;
  /** Key id written to the JWS header for rotation. */
  kid?: string;
  /** Override the unique token id (default: random UUID). */
  jti?: string;
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number;
}

/** Mint a signed room token. */
export function signRoomToken(opts: SignRoomTokenOptions): string {
  if (!VALID_ROLES.has(opts.role)) {
    throw new Error(`signRoomToken: invalid role "${opts.role}"`);
  }
  if (!opts.roomId) throw new Error('signRoomToken: roomId is required');
  if (!opts.secret) throw new Error('signRoomToken: secret is required');

  const nowSec = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const claims: RoomTokenClaims = {
    room: opts.roomId,
    role: opts.role,
    iat: nowSec,
    exp: nowSec + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    jti: opts.jti ?? randomUUID(),
    ...(opts.kid ? { kid: opts.kid } : {}),
  };

  const header = { alg: 'HS256', typ: 'JWT', ...(opts.kid ? { kid: opts.kid } : {}) };
  const signingInput = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(claims))}`;
  const sig = b64urlEncode(hmac(signingInput, opts.secret));
  return `${signingInput}.${sig}`;
}

export interface VerifyRoomTokenOptions {
  secret: SecretResolver;
  /** When set, require the token's `room` claim to equal this value. */
  room?: string;
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number;
  /** Allowed clock skew in seconds (default 30). */
  clockToleranceSec?: number;
}

/**
 * Verify a room token. Returns the decoded claims, or `null` for any failure
 * (bad shape, wrong/unknown key, tampered signature, expired, room mismatch).
 * Never throws on malformed input.
 */
export function verifyRoomToken(token: string, opts: VerifyRoomTokenOptions): RoomTokenClaims | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: unknown; kid?: unknown };
  let claims: RoomTokenClaims;
  try {
    header = JSON.parse(b64urlToBuffer(headerB64).toString('utf8'));
    claims = JSON.parse(b64urlToBuffer(payloadB64).toString('utf8')) as RoomTokenClaims;
  } catch {
    return null;
  }

  if (header.alg !== 'HS256') return null;
  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const secret = resolveSecret(opts.secret, kid);
  if (!secret) return null;

  // Constant-time signature comparison.
  const expected = hmac(`${headerB64}.${payloadB64}`, secret);
  const provided = b64urlToBuffer(sigB64);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  // Structural + role validation.
  if (
    typeof claims.room !== 'string' ||
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number' ||
    typeof claims.jti !== 'string' ||
    !VALID_ROLES.has(claims.role)
  ) {
    return null;
  }

  const nowSec = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const tolerance = opts.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;
  if (claims.exp + tolerance < nowSec) return null; // expired
  if (claims.iat - tolerance > nowSec) return null; // issued in the future

  if (opts.room !== undefined && claims.room !== opts.room) return null;

  return claims;
}

export interface RoomTokenAuthenticatorOptions {
  secret: SecretResolver;
  /** Deny-list check for revoked `jti`s ("revoke this link"). */
  isRevoked?: (jti: string) => boolean | Promise<boolean>;
  now?: () => number;
  clockToleranceSec?: number;
  /**
   * Map verified claims to a `Principal`. Default: a fresh anonymous
   * per-connection userId (the real identity lives in awareness) with the
   * token's role, expiry, and `{ jti, room }` audit metadata.
   */
  principalFor?: (claims: RoomTokenClaims) => Principal;
}

/**
 * Build an `AuthenticateFn` that authorizes a websocket connection from a
 * room token. Pass to `startCollabServer({ authenticate })`.
 */
export function createRoomTokenAuthenticator(
  opts: RoomTokenAuthenticatorOptions,
): AuthenticateFn {
  return async (token, roomId) => {
    const claims = verifyRoomToken(token ?? '', {
      secret: opts.secret,
      room: roomId,
      now: opts.now,
      clockToleranceSec: opts.clockToleranceSec,
    });
    if (!claims) return null;
    if (opts.isRevoked && (await opts.isRevoked(claims.jti))) return null;

    if (opts.principalFor) return opts.principalFor(claims);
    return {
      userId: `anon-${randomUUID()}`,
      role: claims.role,
      expiresAt: claims.exp * 1000,
      meta: { jti: claims.jti, room: claims.room },
    };
  };
}

// ── HTTP mint route ─────────────────────────────────────────────────────────

export interface MintRequestBody {
  roomId: string;
  role: Role;
  /** Requested lifetime in seconds (clamped by `maxTtlSeconds`). */
  ttlSeconds?: number;
}

export interface TokenEndpointOptions {
  /** Secret used to sign newly minted tokens. */
  secret: string;
  /**
   * Authorize a mint request. Receives the requested grant and the verified
   * claims of the caller's bearer token (or `null` if none/invalid). Return the
   * role to actually grant, or `null` to deny (→ 403). This is where consumers
   * encode policy — e.g. "only an `admin` token for this room may mint", or
   * "anyone may create a fresh room and become its owner".
   */
  authorize: (
    request: MintRequestBody,
    context: { bearerClaims: RoomTokenClaims | null },
  ) => Promise<Role | null> | Role | null;
  /** Secret(s) used to verify the caller's bearer token (default: `secret`). */
  verifySecret?: SecretResolver;
  /** Lifetime for minted tokens when the request omits one (default 7 days). */
  defaultTtlSeconds?: number;
  /** Upper bound applied to a requested `ttlSeconds` (default 30 days). */
  maxTtlSeconds?: number;
  /** Key id stamped on minted tokens. */
  kid?: string;
  /** CORS `Access-Control-Allow-Origin` (default `*`). */
  allowOrigin?: string;
  /** Reject bodies larger than this (default 4 KB). */
  maxBodyBytes?: number;
  now?: () => number;
}

function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid-json'));
      }
    });
    req.on('error', reject);
  });
}

function bearerToken(req: http.IncomingMessage): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return undefined;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : undefined;
}

/**
 * Handle `POST /collab/token` (and its CORS preflight). Returns `true` when the
 * request matched this route (and a response was sent), `false` otherwise so
 * the caller can fall through to its own 404.
 */
export async function handleTokenMintRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: TokenEndpointOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/collab/token') return false;

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
    res.writeHead(reason === 'body-too-large' ? 413 : 400, {
      ...cors,
      'content-type': 'application/json',
    });
    res.end(JSON.stringify({ error: reason }));
    return true;
  }

  const reqBody = body as Partial<MintRequestBody>;
  if (
    typeof reqBody?.roomId !== 'string' ||
    !reqBody.roomId ||
    typeof reqBody.role !== 'string' ||
    !VALID_ROLES.has(reqBody.role)
  ) {
    res.writeHead(400, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid-request' }));
    return true;
  }
  const mintReq: MintRequestBody = {
    roomId: reqBody.roomId,
    role: reqBody.role,
    ttlSeconds: typeof reqBody.ttlSeconds === 'number' ? reqBody.ttlSeconds : undefined,
  };

  const bearerClaims = verifyRoomToken(bearerToken(req) ?? '', {
    secret: opts.verifySecret ?? opts.secret,
    now: opts.now,
  });

  let grantedRole: Role | null;
  try {
    grantedRole = await opts.authorize(mintReq, { bearerClaims });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[collab-server] token authorize threw:', err);
    res.writeHead(500, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'authorize-error' }));
    return true;
  }

  if (!grantedRole) {
    res.writeHead(403, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return true;
  }

  const maxTtl = opts.maxTtlSeconds ?? 30 * 24 * 60 * 60;
  const ttlSeconds = Math.min(mintReq.ttlSeconds ?? opts.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS, maxTtl);
  const token = signRoomToken({
    roomId: mintReq.roomId,
    role: grantedRole,
    secret: opts.secret,
    ttlSeconds,
    kid: opts.kid,
    now: opts.now,
  });
  const expSec = Math.floor((opts.now ? opts.now() : Date.now()) / 1000) + ttlSeconds;

  res.writeHead(200, { ...cors, 'content-type': 'application/json' });
  res.end(JSON.stringify({ token, roomId: mintReq.roomId, role: grantedRole, exp: expSec }));
  return true;
}
