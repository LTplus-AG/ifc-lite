/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fresh-room claim ledger behind `createAccessControl` (#6581).
 *
 * The first token minted for a fresh room claims it before the client has put
 * anything in it, and the client can still fail afterwards (seed preparation,
 * the join, a closed tab). So a claim starts PENDING and records every token
 * minted for the room while it is pending. The first authenticated join makes
 * it CONFIRMED, and nothing here ever removes a confirmed claim.
 *
 * A pending claim leaves the ledger in one of two ways:
 *   - RELEASED by the holder of one of its admin tokens. The ledger hands back
 *     every token it recorded so the caller can revoke them: a released room id
 *     can be claimed again, and an old token must not work in the new room.
 *   - EXPIRED once every token it recorded is past its own expiry (plus slack).
 *     No token minted for it can authenticate any more, so a join that could
 *     still succeed is never cut short and nothing needs revoking.
 * Either way the room's slot in the `maxClaimedRooms` allowance is freed.
 * Neither path runs while `hasContent(room)` reports persisted room data.
 */

/**
 * Upper bound on a token's lifetime when the ledger has no expiry for it: the
 * token route's default `maxTtlSeconds` (30 days) plus a day of slack.
 */
export const FALLBACK_TOKEN_RETENTION_SEC = 31 * 24 * 60 * 60;
/** Exceeds the verifier's clock tolerance, so nothing here races a live token. */
export const EXPIRY_SLACK_SEC = 60;
/**
 * Tokens a pending claim may record. A client creating a room needs one (its
 * admin token); the bound keeps a release from feeding the deny-list without
 * limit. Further mints for a pending room are refused, not left unrecorded.
 */
export const MAX_PENDING_CLAIM_TOKENS = 8;

/** The id and expiry (seconds since epoch) of a minted token. */
export interface MintedToken {
  jti: string;
  exp: number;
}

/** A pending claim as persisted: claim time and `jti -> exp` of its tokens. */
export interface PendingClaimRecord {
  at: number;
  tokens: Record<string, number>;
}

export type ReleaseOutcome =
  /** Removed; every token it recorded (`jti -> exp`) must now be revoked. */
  | { kind: 'released'; tokens: Map<string, number> }
  /** Confirmed (joined, or adopted from disk) or holding persisted data. */
  | { kind: 'in-use' }
  /** No such claim, or the bearer is not one of the tokens it recorded. */
  | { kind: 'not-holder' };

export interface RoomClaims {
  readonly size: number;
  has(room: string): boolean;
  isPending(room: string): boolean;
  /** First-touch claim; `token` is the one the claimant will receive. */
  claim(room: string, nowSec: number, token: MintedToken | undefined): 'claimed' | 'taken' | 'full';
  /** Record a further mint for a pending room; false when its record is full. */
  record(room: string, token: MintedToken | undefined): boolean;
  /** Pending to confirmed. Returns whether it was pending. */
  confirm(room: string): boolean;
  release(room: string, bearerJti: string): ReleaseOutcome;
  /** Drop pending claims whose tokens have all expired; returns how many. */
  expire(nowSec: number, room?: string): number;
  snapshot(): { claimedRooms: string[]; pendingClaims: Record<string, PendingClaimRecord> };
}

interface PendingClaim {
  at: number;
  tokens: Map<string, number>;
}

export function createRoomClaims(opts: {
  maxClaimedRooms: number;
  /** Rooms already persisted as confirmed (or adopted from the data dir). */
  claimedRooms: Iterable<string>;
  pendingClaims: Record<string, PendingClaimRecord>;
  /** Whether the room has persisted data; such a room is never removed. */
  hasContent: (room: string) => boolean;
}): RoomClaims {
  const claimed = new Set<string>(opts.claimedRooms);
  const pending = new Map<string, PendingClaim>();
  // A non-finite expiry would persist as `null` and fail the next load closed.
  // No such token can verify, so there is nothing to record.
  const recordable = (token: MintedToken | undefined): token is MintedToken =>
    token !== undefined && Number.isFinite(token.exp);
  for (const [room, rec] of Object.entries(opts.pendingClaims)) {
    claimed.add(room);
    pending.set(room, { at: rec.at, tokens: new Map(Object.entries(rec.tokens)) });
  }

  const expiresAt = (claim: PendingClaim): number => {
    if (claim.tokens.size === 0) return claim.at + FALLBACK_TOKEN_RETENTION_SEC;
    return Math.max(...claim.tokens.values());
  };
  const expireOne = (room: string, claim: PendingClaim, nowSec: number): boolean => {
    if (expiresAt(claim) + EXPIRY_SLACK_SEC >= nowSec || opts.hasContent(room)) return false;
    pending.delete(room);
    claimed.delete(room);
    return true;
  };

  return {
    get size() {
      return claimed.size;
    },
    has: (room) => claimed.has(room),
    isPending: (room) => pending.has(room),
    claim(room, nowSec, token) {
      if (claimed.has(room)) return 'taken';
      if (claimed.size >= opts.maxClaimedRooms) return 'full';
      claimed.add(room);
      const tokens = new Map<string, number>();
      if (recordable(token)) tokens.set(token.jti, token.exp);
      pending.set(room, { at: nowSec, tokens });
      return 'claimed';
    },
    record(room, token) {
      const claim = pending.get(room);
      if (!claim || claim.tokens.size >= MAX_PENDING_CLAIM_TOKENS) return false;
      if (recordable(token)) claim.tokens.set(token.jti, token.exp);
      return true;
    },
    confirm: (room) => pending.delete(room),
    release(room, bearerJti) {
      const claim = pending.get(room);
      if (!claim) return claimed.has(room) ? { kind: 'in-use' } : { kind: 'not-holder' };
      if (!claim.tokens.has(bearerJti)) return { kind: 'not-holder' };
      if (opts.hasContent(room)) return { kind: 'in-use' };
      pending.delete(room);
      claimed.delete(room);
      return { kind: 'released', tokens: claim.tokens };
    },
    expire(nowSec, room) {
      if (room !== undefined) {
        const claim = pending.get(room);
        return claim && expireOne(room, claim, nowSec) ? 1 : 0;
      }
      let n = 0;
      for (const [r, claim] of pending) if (expireOne(r, claim, nowSec)) n++;
      return n;
    },
    snapshot() {
      const pendingClaims: Record<string, PendingClaimRecord> = {};
      for (const [room, claim] of pending) {
        pendingClaims[room] = { at: claim.at, tokens: Object.fromEntries(claim.tokens) };
      }
      // Pending rooms stay in `claimedRooms` too: a server that predates
      // `pendingClaims` then reads them as claimed (fail closed), never free.
      return { claimedRooms: [...claimed], pendingClaims };
    },
  };
}
