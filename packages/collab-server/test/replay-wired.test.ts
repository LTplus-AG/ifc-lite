/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end: wire the anti-replay protector into the room manager
 * via verifyMessage and confirm the audit log records rejects.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { startCollabServer } from '../src/server.js';
import { MemoryPersistence } from '../src/persistence.js';
import { MemoryAuditSink } from '../src/audit-log.js';
import {
  createReplayProtector,
  encodeSignedFrame,
  computeHmac,
  verifyWithReplayProtector,
} from '../src/replay-protect.js';
import { WebSocket } from 'ws';

describe('replay protector wired into the room', () => {
  it('rejects unsigned messages when requireSigned is set', async () => {
    const audit = new MemoryAuditSink();
    const protector = createReplayProtector({ secret: 'topsecret' });
    const verify = verifyWithReplayProtector(protector, { requireSigned: true });

    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
      auditSink: audit,
      verifyMessage: (msg) => {
        const r = verify(msg);
        return { ok: r.ok, reason: r.reason, payload: r.payload };
      },
    });
    const port = (handle.httpServer.address() as { port: number }).port;

    // Open a raw websocket and send an unsigned MESSAGE_SYNC frame.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/room`);
    try {
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      // sync-step1 minimal frame: outer 0 + inner 0 + 0 (state vector
      // length) — y-protocols' wire format. We don't care if the doc
      // accepts it; we just want the verifier to reject as 'unsigned'.
      const unsigned = new Uint8Array([0, 0, 0]);
      ws.send(unsigned);

      await new Promise((r) => setTimeout(r, 100));
      const rejects = audit.entries.filter((e) => e.opType === 'reject');
      expect(rejects.some((e) => (e.detail as { reason?: string } | undefined)?.reason === 'unsigned')).toBe(true);
    } finally {
      // Close the socket and stop the server even if the assertion above
      // throws — otherwise a failing run leaks an open listening server and
      // socket into the rest of the suite (PR #2846 review).
      ws.close();
      await handle.stop();
    }
  }, 10_000);

  it('accepts a properly-signed frame and tracks the clock', () => {
    const protector = createReplayProtector({ secret: 'topsecret' });
    const secret = Buffer.from('topsecret', 'utf8');
    const payload = new Uint8Array([0, 0, 0]);
    const hmac = computeHmac(secret, 1, 1, payload);
    const frame = encodeSignedFrame({ clientId: 1, clock: 1, payload, hmac });
    const verify = verifyWithReplayProtector(protector);
    const ok = verify(frame);
    expect(ok.ok).toBe(true);
    expect(ok.payload).toEqual(payload);

    // Replay → rejected.
    const replay = verify(frame);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('replay');
  });

  it('applies a properly-signed frame to the room doc, not just to the verifier', async () => {
    // The `verify()`-level test above only proves the pure verifier accepts
    // the envelope and returns the unwrapped payload — it never proves the
    // room actually *applies* that payload. Drive it end to end: build a
    // real Y sync-update frame, wrap it in a signed envelope the way the
    // module docs instruct deployers to, and check the server's
    // authoritative Y.Doc for the mutation.
    const SECRET = 'topsecret';
    const audit = new MemoryAuditSink();
    const protector = createReplayProtector({ secret: SECRET });
    const verify = verifyWithReplayProtector(protector, { requireSigned: true });

    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
      auditSink: audit,
      verifyMessage: (msg) => {
        const r = verify(msg);
        return { ok: r.ok, reason: r.reason, payload: r.payload };
      },
    });
    const port = (handle.httpServer.address() as { port: number }).port;

    // Build a real inner sync-update frame (what a legitimate client sends).
    const sourceDoc = new Y.Doc();
    sourceDoc.getMap('test').set('foo', 'from-signed-replay');
    const update = Y.encodeStateAsUpdate(sourceDoc);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0 /* MESSAGE_SYNC */);
    syncProtocol.writeUpdate(enc, update);
    const innerFrame = encoding.toUint8Array(enc);

    const hmac = computeHmac(Buffer.from(SECRET, 'utf8'), 1, 1, innerFrame);
    const signedFrame = encodeSignedFrame({ clientId: 1, clock: 1, payload: innerFrame, hmac });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/signed-e2e-room`);
    try {
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      ws.send(signedFrame);
      await new Promise((r) => setTimeout(r, 300));

      const room = await handle.roomManager.getOrCreate('signed-e2e-room');
      expect(room.doc.getMap('test').get('foo')).toBe('from-signed-replay');
    } finally {
      // Close the socket and stop the server even if the assertion above
      // throws — otherwise a failing run leaks an open listening server and
      // socket into the rest of the suite (PR #2846 review).
      ws.close();
      await handle.stop();
    }
  }, 10_000);

  it('rejects a signed write from a viewer-role connection with reason "role", and does not apply it (#2846)', async () => {
    // Before the fix this PR ships, `preCheckWriteFrame` ran only on the
    // signed ENVELOPE (outer varint = SIGNED_TAG, never MESSAGE_SYNC) and
    // waved it through without consulting role/limiter/size; the unwrapped
    // inner write frame then went straight to the doc. Pin the gate on the
    // unwrapped payload directly: a viewer's validly-signed write must be
    // rejected and must not land.
    const SECRET = 'topsecret';
    const audit = new MemoryAuditSink();
    const protector = createReplayProtector({ secret: SECRET });
    const verify = verifyWithReplayProtector(protector, { requireSigned: true });

    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
      auditSink: audit,
      authenticate: async () => ({ userId: 'viewer-1', role: 'viewer' }),
      verifyMessage: (msg) => {
        const r = verify(msg);
        return { ok: r.ok, reason: r.reason, payload: r.payload };
      },
    });
    const port = (handle.httpServer.address() as { port: number }).port;

    const sourceDoc = new Y.Doc();
    sourceDoc.getMap('test').set('foo', 'VIEWER-WROTE-THIS');
    const update = Y.encodeStateAsUpdate(sourceDoc);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0 /* MESSAGE_SYNC */);
    syncProtocol.writeUpdate(enc, update);
    const innerFrame = encoding.toUint8Array(enc);

    const hmac = computeHmac(Buffer.from(SECRET, 'utf8'), 1, 1, innerFrame);
    const signedFrame = encodeSignedFrame({ clientId: 1, clock: 1, payload: innerFrame, hmac });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/viewer-role-gate-room`);
    try {
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      ws.send(signedFrame);
      await new Promise((r) => setTimeout(r, 300));

      const room = await handle.roomManager.getOrCreate('viewer-role-gate-room');
      expect(room.doc.getMap('test').get('foo')).toBeUndefined();

      const roleRejects = audit.entries.filter(
        (e) => e.opType === 'reject' && (e.detail as { reason?: string } | undefined)?.reason === 'role',
      );
      expect(roleRejects.length).toBeGreaterThan(0);
    } finally {
      ws.close();
      await handle.stop();
    }
  }, 10_000);

  it('rejects a signed frame whose inner update exceeds MAX_SYNC_PAYLOAD_BYTES with reason "sync-size" (#2846)', async () => {
    const SECRET = 'topsecret';
    const audit = new MemoryAuditSink();
    const protector = createReplayProtector({ secret: SECRET });
    const verify = verifyWithReplayProtector(protector, { requireSigned: true });

    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
      auditSink: audit,
      verifyMessage: (msg) => {
        const r = verify(msg);
        return { ok: r.ok, reason: r.reason, payload: r.payload };
      },
    });
    const port = (handle.httpServer.address() as { port: number }).port;

    // An inner frame whose total byte length is well over the 8 MB cap —
    // the padding lives in the sync-update payload itself so the write
    // frame (outer 0 + subtype + update bytes) also clears it.
    const oversizedUpdate = new Uint8Array(9 * 1024 * 1024).fill(1);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0 /* MESSAGE_SYNC */);
    syncProtocol.writeUpdate(enc, oversizedUpdate);
    const innerFrame = encoding.toUint8Array(enc);

    const hmac = computeHmac(Buffer.from(SECRET, 'utf8'), 1, 1, innerFrame);
    const signedFrame = encodeSignedFrame({ clientId: 1, clock: 1, payload: innerFrame, hmac });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/oversized-signed-room`);
    try {
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res());
        ws.once('error', rej);
      });
      ws.send(signedFrame);
      await new Promise((r) => setTimeout(r, 300));

      const sizeRejects = audit.entries.filter(
        (e) => e.opType === 'reject' && (e.detail as { reason?: string } | undefined)?.reason === 'sync-size',
      );
      expect(sizeRejects.length).toBeGreaterThan(0);
    } finally {
      ws.close();
      await handle.stop();
    }
  }, 10_000);
});
