/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Accountless room access control for token-secret deployments (used by
 * `bin.ts`, extracted so the policy and its persistence are testable):
 *   - Joins require a valid signed room token (role is tamper-proof + revocable).
 *   - The *first* token minted for a brand-new room makes its requester admin
 *     (room creation / first-touch). Afterwards only an admin token for that
 *     room may mint further links — so a link's holder can't escalate.
 *   - Admins can revoke a link by `jti` (deny-list).
 *
 * The deny-list + claimed-room set persist to `access-control.json` in the
 * data dir so they survive restarts (needs a durable volume to actually
 * persist). Writes are debounced (a burst of claims collapses to one write)
 * and atomic (temp file + rename, so a crash mid-write never leaves a torn
 * state file); `flush()` awaits any pending/in-flight write for the shutdown
 * path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRoomTokenAuthenticator, createRoomTokenRegistryAuthorizer, verifyRoomToken } from './room-token.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import { type Role } from './auth.js';
import type { StartCollabServerOptions } from './server.js';

export interface AccessControlOptions {
  /** Token signing/verification secret (`COLLAB_TOKEN_SECRET`). */
  secret: string;
  /** Data dir holding `access-control.json` (shared with rooms/blobs). */
  dir: string;
  /** Cap on the claimed-rooms set (default 100_000). */
  maxClaimedRooms?: number;
  /**
   * Honor `X-Forwarded-For` when rate-limiting mints (default OFF). Enable
   * only behind a trusted reverse proxy — see `TokenEndpointOptions`.
   */
  trustForwardedFor?: boolean;
  /** Debounce for coalesced state writes, in ms (default 250). */
  persistDebounceMs?: number;
  /** Mint rate limit: burst capacity per client IP (default 30). */
  mintRateCapacity?: number;
  /** Mint rate limit: refill in tokens/second (default 0.5). */
  mintRateRefillPerSecond?: number;
  /** Bound on the per-IP limiter map (default 4096). */
  maxRateLimiters?: number;
}

export interface AccessControl {
  /** Spread into `startCollabServer(...)` options. */
  serverOptions: Partial<StartCollabServerOptions>;
  /**
   * Await any pending/in-flight state write. Call before `process.exit` in
   * shutdown handlers — a SIGTERM during the persist debounce (or mid-write)
   * would otherwise lose claims/revocations.
   */
  flush(): Promise<void>;
}

export function createAccessControl(opts: AccessControlOptions): AccessControl {
  const { secret, dir } = opts;
  // Persist the revocation deny-list + claimed-room set to disk so they survive
  // restarts. Without this, a restart (a) forgets revocations and (b) lets the
  // first POST /collab/token for an already-claimed persisted room take it over
  // with a fresh admin token.
  const statePath = path.join(dir, 'access-control.json');
  const revoked = new Set<string>();
  const claimedRooms = new Set<string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      revoked?: string[];
      claimedRooms?: string[];
    };
    for (const j of parsed.revoked ?? []) revoked.add(j);
    for (const r of parsed.claimedRooms ?? []) claimedRooms.add(r);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // eslint-disable-next-line no-console
      console.warn('[collab-server] could not read access-control state:', err);
    }
  }
  // Persistence used to be a synchronous full-file `writeFileSync` on *every*
  // claim/revocation — a cheap way for an attacker looping mint calls to pin
  // the event loop on disk I/O. Coalesce writes behind a short debounce and a
  // single in-flight drain so a burst of claims collapses to one async write.
  // The write is atomic (temp file in the same dir, then rename over the
  // target) so a crash mid-write can never leave a torn/corrupt state file.
  const persistDebounceMs = opts.persistDebounceMs ?? 250;
  const tmpPath = `${statePath}.tmp`;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> | null = null;
  let dirty = false;
  const writeOnce = async () => {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        tmpPath,
        JSON.stringify({ revoked: [...revoked], claimedRooms: [...claimedRooms] }),
      );
      await fs.promises.rename(tmpPath, statePath);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[collab-server] could not persist access-control state:', err);
    }
  };
  // Serialized drain: one writer at a time; a claim/revocation landing while a
  // write is in flight re-marks `dirty`, and the loop runs one more pass so the
  // snapshot on disk is never stale.
  const drain = async () => {
    while (dirty) {
      dirty = false;
      await writeOnce();
    }
  };
  const kick = () => {
    if (!writing) {
      writing = drain().finally(() => {
        writing = null;
      });
    }
  };
  const persist = () => {
    dirty = true;
    if (writeTimer || writing) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      kick();
    }, persistDebounceMs);
    // Don't keep the event loop alive solely for a pending persist.
    writeTimer.unref?.();
  };
  const flush = async () => {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    while (dirty || writing) {
      kick();
      await writing;
    }
  };

  // Bound `claimedRooms` growth. Each fresh-room first-claim adds an entry that
  // persists forever; without a ceiling an attacker (or a very long-lived
  // deployment) grows the set — and every serialized write — without limit.
  // Legitimate multi-room deployments stay well under the default 100k cap.
  const maxClaimedRooms = opts.maxClaimedRooms ?? 100_000;

  // Per-IP rate limiter for the unauthenticated mint path. A fresh room's first
  // mint needs no bearer, so without this an attacker can loop `POST
  // /collab/token` to mint admin tokens (and grow `claimedRooms`) for free.
  // Generous burst so legitimate admins minting several links never trip it.
  const mintRateCapacity = opts.mintRateCapacity ?? 30;
  const mintRateRefillPerSecond = opts.mintRateRefillPerSecond ?? 0.5; // ~30 mints/min sustained per IP
  const maxRateLimiters = opts.maxRateLimiters ?? 4096; // bound the per-IP map so it isn't its own DoS
  const mintLimiters = new Map<string, RateLimiter>();
  const mintRateAllows = (clientIp: string | undefined): boolean => {
    const key = clientIp && clientIp.length > 0 ? clientIp : 'unknown';
    let limiter = mintLimiters.get(key);
    if (!limiter) {
      if (mintLimiters.size >= maxRateLimiters) {
        // Coarse eviction: drop the oldest-inserted entries so a spray of
        // spoofed source IPs can't grow the map unboundedly.
        const evict = Math.ceil(maxRateLimiters / 8);
        let n = 0;
        for (const k of mintLimiters.keys()) {
          mintLimiters.delete(k);
          if (++n >= evict) break;
        }
      }
      limiter = createRateLimiter({
        capacity: mintRateCapacity,
        refillPerSecond: mintRateRefillPerSecond,
      });
      mintLimiters.set(key, limiter);
    }
    return limiter.tryConsume(1);
  };

  const serverOptions: Partial<StartCollabServerOptions> = {
    authenticate: createRoomTokenAuthenticator({ secret, isRevoked: (jti) => revoked.has(jti) }),
    // Blobs are content-addressed and NOT room-scoped, but the default blob
    // authorizer reuses the WS `authenticate` with a pseudo-room scope — which
    // a room-bound token can never match. Verify signature/expiry/revocation
    // without the room binding instead; writes additionally need editor/admin.
    // The registry is project-scoped like blobs: verify the token without
    // its room binding (see createRoomTokenRegistryAuthorizer) — otherwise
    // room tokens can never reach /api/v1 and the registry is locked out.
    authorizeRegistry: createRoomTokenRegistryAuthorizer({
      secret,
      isRevoked: (jti) => revoked.has(jti),
    }),
    authorizeBlob: (token, method) => {
      const claims = verifyRoomToken(token ?? '', { secret });
      if (!claims || revoked.has(claims.jti)) return false;
      if (method === 'PUT' || method === 'DELETE') {
        return claims.role === 'editor' || claims.role === 'admin';
      }
      // DESIGN NOTE (flagged, deliberate): blobs are global and
      // content-addressed, so this check drops the room binding — any valid
      // editor/admin token may PUT/DELETE any blob hash regardless of which
      // room it belongs to. In a multi-tenant deployment that means a DELETE
      // from tenant A can remove a content-identical blob referenced by tenant
      // B (and a PUT could pre-seed one). This is accepted as part of the
      // content-addressed model (identical bytes are one object); if per-tenant
      // blob isolation is ever required, blobs must be namespaced/reference-
      // counted per room instead of relaxing the room binding here.
      return true;
    },
    tokenEndpoint: {
      secret,
      trustForwardedFor: opts.trustForwardedFor === true,
      // A revoked bearer (e.g. a kicked admin) is treated as absent before the
      // authorize policy even runs; the policy's own check below is defense in
      // depth for custom deployments that omit `isRevoked`.
      isRevoked: (jti) => revoked.has(jti),
      authorize: (request, { bearerClaims, clientIp }): Role | null => {
        const room = request.roomId;
        // A revoked bearer must not be able to keep minting links, even though
        // its signature + expiry still verify.
        if (bearerClaims?.jti && revoked.has(bearerClaims.jti)) return null;
        // An admin token for this room can re-mint links without tripping the
        // per-IP budget — the throttle targets the unauthenticated fresh-room
        // path an attacker abuses, not authenticated re-mints.
        if (bearerClaims?.room === room && bearerClaims.role === 'admin') return request.role;
        // Everything below is the unauthenticated "first claim of a fresh room
        // becomes admin" path: rate-limit it per IP so it can't be looped.
        if (!mintRateAllows(clientIp)) return null;
        if (!claimedRooms.has(room)) {
          if (claimedRooms.size >= maxClaimedRooms) {
            // eslint-disable-next-line no-console
            console.warn(
              `[collab-server] claimedRooms cap (${maxClaimedRooms}) reached; refusing new fresh-room claim`,
            );
            return null;
          }
          claimedRooms.add(room);
          persist();
          return 'admin'; // creator of a fresh room
        }
        return null; // claimed room + non-admin caller → denied
      },
    },
    revokeEndpoint: {
      secret,
      isRevoked: (jti) => revoked.has(jti),
      recordRevocation: (jti) => {
        revoked.add(jti);
        persist();
      },
    },
    kickEndpoint: { secret, isRevoked: (jti) => revoked.has(jti) },
  };

  return { serverOptions, flush };
}
