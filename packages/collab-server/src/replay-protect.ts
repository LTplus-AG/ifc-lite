/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anti-replay verification (open problem #8).
 *
 * Every authenticated peer can send Y updates over the websocket. The
 * server validates the JWT on connect, but unless the bytes themselves
 * are signed, a malicious peer with a valid token can replay or forge
 * updates.
 *
 * This module ships an opt-in HMAC-SHA256 verifier:
 *   - Client side (out of scope here): tag each update with
 *     `H = hmac_sha256(secret, clientId || clock || update)`.
 *   - Server side: validate `H` and enforce monotonic clocks per
 *     clientId so old payloads can't be replayed.
 *
 * The verifier is provided as a pure function so deployers wire it into
 * their handler pipeline alongside the existing `canWrite` role check.
 */

import * as crypto from 'node:crypto';

export interface UpdateEnvelope {
  clientId: number;
  clock: number;
  payload: Uint8Array;
  hmac: string;
}

export interface ReplayDecision {
  ok: boolean;
  reason?: 'bad-mac' | 'replay' | 'malformed';
}

export interface ReplayProtector {
  /**
   * Verify `envelope` against the configured secret + the tracked
   * highest-seen clock. Increments the tracked clock on success.
   */
  verify(envelope: UpdateEnvelope): ReplayDecision;
  /** Get the highest accepted clock for a clientId (0 if unseen). */
  highestClock(clientId: number): number;
  /** Reset internal state (tests / room recycling). */
  reset(): void;
}

export interface ReplayProtectorOptions {
  /** HMAC-SHA256 secret. Must match the client. */
  secret: string;
  /** Maximum clock drift accepted in either direction (default 0 = strict monotonic). */
  driftTolerance?: number;
}

export function createReplayProtector(opts: ReplayProtectorOptions): ReplayProtector {
  const secret = Buffer.from(opts.secret, 'utf8');
  const drift = opts.driftTolerance ?? 0;
  const seen = new Map<number, number>();

  return {
    verify(envelope) {
      if (
        typeof envelope.clientId !== 'number' ||
        typeof envelope.clock !== 'number' ||
        !(envelope.payload instanceof Uint8Array) ||
        typeof envelope.hmac !== 'string'
      ) {
        return { ok: false, reason: 'malformed' };
      }

      const expected = computeHmac(secret, envelope.clientId, envelope.clock, envelope.payload);
      if (!constantTimeEqual(envelope.hmac, expected)) {
        return { ok: false, reason: 'bad-mac' };
      }

      const last = seen.get(envelope.clientId) ?? 0;
      if (envelope.clock + drift <= last) {
        return { ok: false, reason: 'replay' };
      }

      seen.set(envelope.clientId, envelope.clock);
      return { ok: true };
    },
    highestClock(clientId) {
      return seen.get(clientId) ?? 0;
    },
    reset() {
      seen.clear();
    },
  };
}

/**
 * Compute an HMAC-SHA256 hex digest over `(clientId || clock || payload)`.
 * Exposed so clients in tests (and non-Node environments) can produce
 * matching tags from the same canonical encoding.
 */
export function computeHmac(secret: Buffer, clientId: number, clock: number, payload: Uint8Array): string {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(0, 0);
  header.writeUInt32BE(clientId >>> 0, 4);
  header.writeUInt32BE(0, 8);
  header.writeUInt32BE(clock >>> 0, 12);
  return crypto.createHmac('sha256', secret).update(header).update(payload).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Wire integration                                                     */
/* ------------------------------------------------------------------ */

/**
 * Default envelope decoder for messages of the form
 * `[1B SIGNED_TAG = 0xff][4B clientId][4B clock][32B HMAC hex'd ascii][N B payload]`.
 *
 * Total framing overhead is 1 + 4 + 4 + 64 + N = 73 + N bytes — small
 * relative to typical Y updates. Apps with their own envelope can
 * write a custom verifier instead.
 */
const SIGNED_TAG = 0xff;

export function decodeSignedFrame(frame: Uint8Array): UpdateEnvelope | null {
  if (frame.byteLength < 1 + 4 + 4 + 64) return null;
  if (frame[0] !== SIGNED_TAG) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const clientId = view.getUint32(1, false);
  const clock = view.getUint32(5, false);
  const hmac = new TextDecoder('ascii').decode(frame.subarray(9, 9 + 64));
  const payload = frame.subarray(9 + 64);
  return { clientId, clock, payload, hmac };
}

export function encodeSignedFrame(envelope: UpdateEnvelope): Uint8Array {
  const payload = envelope.payload;
  const out = new Uint8Array(1 + 4 + 4 + 64 + payload.byteLength);
  out[0] = SIGNED_TAG;
  const view = new DataView(out.buffer);
  view.setUint32(1, envelope.clientId >>> 0, false);
  view.setUint32(5, envelope.clock >>> 0, false);
  out.set(new TextEncoder().encode(envelope.hmac), 9);
  out.set(payload, 9 + 64);
  return out;
}

/**
 * Adapter from a `ReplayProtector` to the server's `VerifyMessageFn`
 * shape. Frames whose first byte is the `SIGNED_TAG` are parsed and
 * verified; messages that aren't tagged are passed through (for clients
 * that don't sign). To force-reject unsigned messages, set
 * `requireSigned: true`.
 */
export function verifyWithReplayProtector(
  protector: ReplayProtector,
  options: { requireSigned?: boolean } = {},
): (msg: Uint8Array) => { ok: boolean; reason?: string; payload?: Uint8Array } {
  return (msg) => {
    if (msg.byteLength === 0 || msg[0] !== SIGNED_TAG) {
      if (options.requireSigned) return { ok: false, reason: 'unsigned' };
      return { ok: true };
    }
    const envelope = decodeSignedFrame(msg);
    if (!envelope) return { ok: false, reason: 'malformed' };
    const result = protector.verify(envelope);
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, payload: envelope.payload };
  };
}
