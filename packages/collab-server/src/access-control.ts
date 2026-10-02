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
 *   - A first-touch claim stays pending until the room's first authenticated
 *     join (`room-claims.ts`, #6581). Until then the client that claimed it can
 *     hand it back (`POST /collab/release`, which revokes every token minted
 *     for it), and it expires on its own once all of those tokens have. The
 *     join that confirms a claim is admitted only once that is on disk.
 *     Only with `claimsPendingUntilJoin`, since joins confirm claims through
 *     `serverOptions.authenticate`; without it every claim is permanent.
 *
 * The deny-list + claim ledger persist to `access-control.json` in the data
 * dir so they survive restarts (needs a durable volume to actually persist).
 * Writes are debounced (a burst of claims collapses to one write) and atomic
 * (temp file + rename, so a crash mid-write never leaves a torn state file);
 * `flush()` awaits any pending/in-flight write for the shutdown path and
 * REJECTS when the final state never reached disk.
 *
 * Load is fail-closed: a state file that exists but cannot be read or parsed
 * throws at startup instead of silently running open. A MISSING state file
 * with rooms already persisted in the data dir (upgrade from a pre-state
 * version, or a lost/unmounted volume) marks those rooms claimed so a
 * squatter cannot first-claim them; their admins keep minting with their
 * still-valid admin bearers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createRoomTokenAuthenticator,
  createRoomTokenRegistryAuthorizer,
  DEFAULT_CLOCK_TOLERANCE_SEC,
  verifyRoomToken,
  type RoomTokenClaims,
} from './room-token.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import { type AuthenticateFn, type Role } from './auth.js';
import type { StartCollabServerOptions } from './server.js';
import {
  createStateWriter,
  hasPersistedRoomLog,
  listPersistedRoomIds,
  parseStateFile,
} from './access-control-state.js';
import {
  createRoomClaims,
  EXPIRY_SLACK_SEC,
  FALLBACK_TOKEN_RETENTION_SEC,
} from './room-claims.js';

export interface AccessControlOptions {
  /** Token signing/verification secret (`COLLAB_TOKEN_SECRET`). */
  secret: string;
  /** Data dir holding `access-control.json` (shared with rooms/blobs). */
  dir: string;
  /** Cap on claimed rooms, pending and confirmed together (default 100_000). */
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
  /** Clock in ms since epoch (default `Date.now`), for minting, verifying and claim expiry. */
  now?: () => number;
  /**
   * Keep a fresh room's claim pending until its first join, so a failed
   * creation can be released (`POST /collab/release`) or expire (#6581).
   * Set it only when the server authenticates joins with
   * `serverOptions.authenticate` (as is, or a wrapper that calls it): that
   * is what confirms a joined room. Default off: every claim is permanent
   * from its first mint, and a release answers 409.
   */
  claimsPendingUntilJoin?: boolean;
  /**
   * Deny-list size past which a release is refused (default 1024), leaving
   * the claim to expire instead. Revoke and kick are never refused.
   */
  maxRevocationsForRelease?: number;
}

export interface AccessControl {
  /** Spread into `startCollabServer(...)` options. */
  serverOptions: Partial<StartCollabServerOptions>;
  /**
   * Await any pending/in-flight state write. Call before `process.exit` in
   * shutdown handlers — a SIGTERM during the persist debounce (or mid-write)
   * would otherwise lose claims/revocations. Rejects when the state could
   * not be written (the caller must NOT report a durable shutdown).
   */
  flush(): Promise<void>;
}

export function createAccessControl(opts: AccessControlOptions): AccessControl {
  const { secret, dir } = opts;
  const nowSec = () => Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  // Persist the revocation deny-list + claim ledger to disk so they survive
  // restarts. Without this, a restart (a) forgets revocations and (b) lets the
  // first POST /collab/token for an already-claimed persisted room take it over
  // with a fresh admin token.
  const statePath = path.join(dir, 'access-control.json');
  /** jti -> token expiry (seconds since epoch); expired entries are pruned. */
  const revoked = new Map<string, number>();
  let loadedRooms: string[] = [];
  let loadedPending: ReadonlyMap<string, { at: number; tokens: ReadonlyMap<string, number> }> = new Map();
  let stateRaw: string | null = null;
  try {
    stateRaw = fs.readFileSync(statePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Unreadable-but-present state (permissions, I/O error): fail CLOSED.
      // Proceeding as "fresh" would forget every revocation and re-open every
      // claimed room for first-touch takeover.
      throw new Error(
        `[collab-server] could not read access-control state at ${statePath} (${String(err)}); refusing to start open`,
      );
    }
    // ENOENT: either a genuinely fresh install, or an upgrade / lost state
    // file on a deployment that already has rooms. Mark any persisted rooms
    // claimed so a squatter cannot first-claim them; their admins keep
    // minting via their still-valid admin bearer tokens.
    loadedRooms = listPersistedRoomIds(dir);
    if (loadedRooms.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[collab-server] access-control state missing but ${loadedRooms.length} persisted room(s) found; ` +
          'marking them claimed (their admins re-mint links with existing admin bearers)',
      );
    }
  }
  if (stateRaw !== null) {
    const loaded = parseStateFile(stateRaw, statePath);
    for (const [jti, exp] of loaded.revoked) revoked.set(jti, exp);
    loadedRooms = loaded.claimedRooms;
    loadedPending = loaded.pendingClaims;
  }
  // Bound the claim ledger. Each fresh-room first-claim adds an entry; without
  // a ceiling an attacker (or a very long-lived deployment) grows it — and
  // every serialized write — without limit. Legitimate multi-room deployments
  // stay well under the default 100k cap.
  const maxClaimedRooms = opts.maxClaimedRooms ?? 100_000;
  const pendingUntilJoin = opts.claimsPendingUntilJoin === true;
  // ~50 bytes per entry in access-control.json: at most ~52 KB from releases.
  const maxRevocationsForRelease = opts.maxRevocationsForRelease ?? 1024;
  // Not opted in: claims an earlier run left pending become permanent too.
  const confirmedOnLoad = pendingUntilJoin ? 0 : loadedPending.size;
  const roomClaims = createRoomClaims({
    maxClaimedRooms,
    claimedRooms: pendingUntilJoin ? loadedRooms : [...loadedRooms, ...loadedPending.keys()],
    pendingClaims: pendingUntilJoin ? loadedPending : new Map(),
    hasContent: (room) => hasPersistedRoomLog(dir, room),
  });
  /** Drop revocations whose tokens have expired on their own (bounded set). */
  const pruneRevoked = () => {
    const t = nowSec();
    for (const [jti, exp] of revoked) {
      if (exp + EXPIRY_SLACK_SEC < t) revoked.delete(jti);
    }
  };
  pruneRevoked();
  const expiredOnLoad = roomClaims.expire(nowSec());
  /** Rooms whose claim was confirmed by a join that waits for it to reach disk. */
  const awaitingDurable = new Set<string>();
  const { persist, flush } = createStateWriter({
    dir,
    statePath,
    debounceMs: opts.persistDebounceMs ?? 250,
    serialize: () => {
      pruneRevoked(); // periodic pruning: every persisted snapshot is bounded
      roomClaims.expire(nowSec());
      const covered = [...awaitingDurable];
      return {
        text: JSON.stringify({ revoked: Object.fromEntries(revoked), ...roomClaims.snapshot() }),
        written: () => {
          for (const room of covered) awaitingDurable.delete(room);
        },
      };
    },
  });
  // Rooms adopted from a missing-state migration (see above), and claims that
  // expired while the server was down, must reach disk without waiting for
  // the next claim to trigger a write.
  if ((stateRaw === null && roomClaims.size > 0) || expiredOnLoad + confirmedOnLoad > 0) persist();

  // Per-IP rate limiter for the unauthenticated mint path. A fresh room's first
  // mint needs no bearer, so without this an attacker can loop `POST
  // /collab/token` to mint admin tokens (and grow the claim ledger) for free.
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
  // A full sweep of expired pending claims runs only at the cap, and at most
  // once a second, so refused claims cannot turn into repeated full scans.
  let lastSweepSec = -1;
  /** `verifyRoomToken`'s expiry rule, for claims a route verified before an await. */
  const expiredNow = (claims: RoomTokenClaims) => claims.exp + DEFAULT_CLOCK_TOLERANCE_SEC < nowSec();

  const verifyJoin = createRoomTokenAuthenticator({ secret, isRevoked: (jti) => revoked.has(jti), now: opts.now });
  const authenticate: AuthenticateFn = async (token, roomId) => {
    const principal = await verifyJoin(token, roomId);
    if (!principal) return null;
    // Re-verified synchronously: a release that revoked this token, or the
    // clock passing its expiry, while the check above awaited must still win.
    const claims = verifyRoomToken(token ?? '', { secret, room: roomId, now: opts.now });
    if (!claims || revoked.has(claims.jti)) return null;
    if (roomClaims.confirm(roomId)) {
      awaitingDurable.add(roomId);
      persist();
    }
    if (!awaitingDurable.has(roomId)) return principal;
    // The room is in use from here on. Admit the join only once that is on
    // disk: a restart that lost it would reload the claim as pending, and a
    // pending claim on a room with data could be released or expire.
    try {
      await flush();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[collab-server] refusing a join: the room's claim could not be persisted:`, err);
      return null;
    }
    // A flush that resolved wrote this confirmation: it was recorded before
    // the flush began, and flush() returns only after a successful pass that
    // started later. Revocation or expiry may have landed while it waited.
    const stillValid = verifyRoomToken(token ?? '', { secret, room: roomId, now: opts.now });
    return stillValid && !revoked.has(claims.jti) ? principal : null;
  };

  const serverOptions: Partial<StartCollabServerOptions> = {
    authenticate,
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
      const claims = verifyRoomToken(token ?? '', { secret, now: opts.now });
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
      now: opts.now,
      trustForwardedFor: opts.trustForwardedFor === true,
      // A revoked bearer (e.g. a kicked admin) is treated as absent before the
      // authorize policy even runs; the policy's own check below is defense in
      // depth for custom deployments that omit `isRevoked`.
      isRevoked: (jti) => revoked.has(jti),
      authorize: (request, { bearerClaims, clientIp, mint }): Role | null => {
        const room = request.roomId;
        // A revoked bearer must not be able to keep minting links, even though
        // its signature + expiry still verify. Both are re-checked here: the
        // route verified the bearer before awaiting its own revocation check.
        if (bearerClaims && (revoked.has(bearerClaims.jti) || expiredNow(bearerClaims))) return null;
        // An admin token for this room can re-mint links without tripping the
        // per-IP budget — the throttle targets the unauthenticated fresh-room
        // path an attacker abuses, not authenticated re-mints. A PENDING claim
        // is that path still: its admin came from a free first touch, and a
        // release turns each token into a deny-list entry. So its mints pay
        // the same budget, are recorded (a release revokes them all), and stop
        // at the claim's bound rather than go unrecorded.
        if (bearerClaims?.room === room && bearerClaims.role === 'admin') {
          if (roomClaims.isPending(room)) {
            if (!mintRateAllows(clientIp) || !roomClaims.record(room, mint)) return null;
            persist();
          }
          return request.role;
        }
        // Everything below is the unauthenticated "first claim of a fresh room
        // becomes admin" path: rate-limit it per IP so it can't be looped.
        if (!mintRateAllows(clientIp)) return null;
        const t = nowSec();
        let expired = roomClaims.expire(t, room);
        let outcome = roomClaims.claim(room, t, mint);
        if (outcome === 'full' && t !== lastSweepSec) {
          lastSweepSec = t;
          expired += roomClaims.expire(t);
          outcome = roomClaims.claim(room, t, mint);
        }
        if (outcome === 'claimed' && !pendingUntilJoin) roomClaims.confirm(room);
        if (expired > 0 || outcome === 'claimed') persist();
        if (outcome === 'full') {
          // eslint-disable-next-line no-console
          console.warn(
            `[collab-server] claimedRooms cap (${maxClaimedRooms}) reached; refusing new fresh-room claim`,
          );
          return null;
        }
        // Creator of a fresh room; a claimed room + non-admin caller is denied.
        return outcome === 'claimed' ? 'admin' : null;
      },
    },
    revokeEndpoint: {
      secret,
      now: opts.now,
      isRevoked: (jti) => revoked.has(jti),
      recordRevocation: (jti, _room, expSec) => {
        // Retain each revocation until the token it kills has expired anyway
        // (plus slack), so the deny-list stays bounded WITHOUT ever evicting a
        // live revocation. The revoke route passes the verified token's `exp`;
        // the kick path has no expiry in hand and gets the fallback horizon
        // (the max mintable TTL), which can only over-retain, never under.
        revoked.set(
          jti,
          typeof expSec === 'number' && Number.isFinite(expSec)
            ? expSec
            : nowSec() + FALLBACK_TOKEN_RETENTION_SEC,
        );
        persist();
      },
    },
    kickEndpoint: { secret, isRevoked: (jti) => revoked.has(jti) },
    releaseEndpoint: {
      secret,
      now: opts.now,
      isRevoked: (jti) => revoked.has(jti),
      release: (bearer) => {
        // Re-checked synchronously: the route's own revocation check awaited,
        // and revocation or expiry may have landed meanwhile.
        if (revoked.has(bearer.jti) || expiredNow(bearer)) return 'not-holder';
        // A release is the one deny-list writer an unauthenticated client can
        // drive, so it stops at `maxRevocationsForRelease` live entries. Past
        // that it is refused and the claim expires with its tokens instead.
        pruneRevoked();
        const fits = (n: number) => revoked.size + n <= maxRevocationsForRelease;
        const outcome = roomClaims.release(bearer.room, bearer.jti, fits);
        if (outcome.kind !== 'released') return outcome.kind;
        // The id can be claimed again; no token minted for it may follow it.
        for (const [jti, exp] of outcome.tokens) revoked.set(jti, exp);
        persist();
        return 'released';
      },
    },
  };

  return { serverOptions, flush };
}
