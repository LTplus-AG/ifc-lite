/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Public type surface for `room-manager.ts`, split out to keep that file
 * under its module-size budget (AGENTS.md). Re-exported from
 * `room-manager.js` and `index.ts` unchanged, so this split is not a public
 * API move.
 */

import type { WebSocket } from 'ws';
import type { Persistence } from './persistence.js';
import type { Principal } from './auth.js';
import type { AuditSink } from './audit-log.js';
import type { RateLimitOptions, RateLimiter } from './rate-limit.js';

export interface VerifyDecision {
  ok: boolean;
  /** Audit-friendly reason string when ok=false. */
  reason?: string;
  /**
   * Optional replacement payload to dispatch instead of the raw wire
   * message — e.g. the anti-replay protector unwraps its signed envelope
   * (tag + clientId + clock + hmac + inner frame) down to the inner
   * y-protocol frame here. Without this, the envelope bytes themselves
   * would be handed to `dispatchMessage`, which doesn't recognise them as
   * a sync/awareness frame and silently drops them in its `default` case.
   */
  payload?: Uint8Array;
}

export type VerifyMessageFn = (msg: Uint8Array, conn: PeerConnection) => VerifyDecision;

export interface RoomOptions {
  persistence: Persistence;
  /** Compact the persisted log every N updates (default 1000). */
  compactEvery?: number;
  /** Idle timeout before a room is unloaded (default 60s). */
  idleUnloadMs?: number;
  /** Audit sink for connect/update/awareness events (default = no-op). */
  auditSink?: AuditSink;
  /**
   * Per-peer rate-limit knobs. Applied per connection. Service accounts
   * (e.g. MCP agents) typically get a tighter budget than humans.
   */
  rateLimit?: RateLimitOptions | ((principal: Principal) => RateLimitOptions);
  /**
   * Optional per-message verifier. For plain sync write-frames the cheap
   * expiry + role + rate-limit + payload-size gate (preCheckWriteFrame) runs
   * FIRST, so a non-writer / expired / rate-limited / oversized frame is
   * rejected before the verifier parses it (avoids Y.Doc-parse
   * amplification). Signed-envelope frames (e.g. the anti-replay
   * protector's `0xff`-tagged frames) aren't recognised as sync
   * write-frames by that first peek, so the verifier runs first for them
   * and sees every signed frame — but if the verifier unwraps the envelope
   * and returns `payload`, `handleMessage` re-runs `preCheckWriteFrame` on
   * THAT payload before dispatch. The unwrapped frame is a real write frame
   * the outer peek never saw, so it must still clear expiry / role /
   * rate-limit / size before it reaches the doc. Returning `{ ok: false }`
   * audits as `reject` with `reason`.
   */
  verifyMessage?: VerifyMessageFn;
  /** Internal: metric counters injected by the manager. */
  counters?: { update?: () => void; reject?: (reason: string) => void };
}

export interface PeerConnection {
  ws: WebSocket;
  principal: Principal;
  /** Subscribed clientIDs that this peer's awareness has reported (for cleanup). */
  awarenessClients: Set<number>;
  /** Per-connection rate limiter. */
  limiter?: RateLimiter;
}
