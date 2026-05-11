/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end: wire the anti-replay protector into the room manager
 * via verifyMessage and confirm the audit log records rejects.
 */

import { describe, expect, it } from 'vitest';
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
        return { ok: r.ok, reason: r.reason };
      },
    });
    const port = (handle.httpServer.address() as { port: number }).port;

    // Open a raw websocket and send an unsigned MESSAGE_SYNC frame.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/room`);
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

    ws.close();
    await handle.stop();
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
});
