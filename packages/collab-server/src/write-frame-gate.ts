/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cheap pre-verify guard for `Room.handleMessage` (moved out of
 * room-manager.ts unchanged, for its module-size budget).
 */

import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import { canWrite } from './auth.js';
import { isPrincipalExpired } from './principal-expiry.js';
import type { PeerConnection } from './room-types.js';

/** Outer y-websocket message type for sync frames (room-manager's MESSAGE_SYNC). */
const MESSAGE_SYNC = 0;

// Inner sync-message subtypes (mirror y-protocols/sync constants) used for
// the cheap pre-verify frame peek. Kept local so the peek never has to call
// the full readSyncMessage (which applies payloads to the doc as a side
// effect). Step2 (1) and Update (2) carry a doc-mutating payload.
const SYNC_STEP2 = syncProtocol.messageYjsSyncStep2;
const SYNC_UPDATE = syncProtocol.messageYjsUpdate;

/**
 * Hard ceiling on a single sync write-frame, enforced before the
 * path-lock verifier parses it through a throwaway Y.Doc. Bounds the
 * O(update_size) allocation an attacker can force per message. 8 MB is
 * far above any legitimate incremental Y update; whole-doc state lands
 * via persistence, not a single wire frame.
 */
const MAX_SYNC_PAYLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Peeks the outer + inner frame type without applying anything to the doc
 * and, for sync write-frames, enforces the role gate, the per-connection rate
 * limiter, and a payload-size bound. Returns the rejection reason, or `null`
 * when it is safe to continue to verifyMessage / dispatch. The caller audits
 * and counts a rejection.
 *
 * A frame whose header can't be peeked is waved through — the downstream
 * decode in dispatchMessage owns the `malformed` audit so we don't
 * double-count it here.
 */
export function writeFrameRejection(conn: PeerConnection, msg: Uint8Array): string | null {
  let subtype: number;
  try {
    const decoder = decoding.createDecoder(msg);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return null;
    subtype = decoding.peekVarUint(decoder);
  } catch {
    // Unreadable header: let dispatchMessage produce the malformed audit.
    return null;
  }
  if (subtype !== SYNC_UPDATE && subtype !== SYNC_STEP2) return null;
  // Immediate half of the #3441 expiry re-check; see principal-expiry.ts.
  if (isPrincipalExpired(conn.principal, Date.now())) return 'expired';
  if (!canWrite(conn.principal)) return 'role';
  if (conn.limiter && !conn.limiter.tryConsume(1)) return 'rate-limit';
  if (msg.byteLength > MAX_SYNC_PAYLOAD_BYTES) return 'sync-size';
  return null;
}
