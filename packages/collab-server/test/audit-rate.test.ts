/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { MemoryPersistence, startCollabServer } from '../src/server.js';
import { MemoryAuditSink, shortHash } from '../src/audit-log.js';
import { createRateLimiter } from '../src/rate-limit.js';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';

describe('audit log + rate limit', () => {
  it('shortHash is stable and 8 hex chars', () => {
    const a = shortHash(new Uint8Array([1, 2, 3, 4, 5]));
    const b = shortHash(new Uint8Array([1, 2, 3, 4, 5]));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('token bucket refills over time', async () => {
    // Use fake timers so the test is deterministic on slow CI. The rate
    // limiter reads Date.now() for refill timing; a few real milliseconds
    // between consumes used to be enough to refill a token at 100 tokens/s.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    try {
      const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 100 });
      expect(limiter.tryConsume(1)).toBe(true);
      expect(limiter.tryConsume(1)).toBe(true);
      expect(limiter.tryConsume(1)).toBe(true);
      // Bucket empty, no virtual time has passed → must reject.
      expect(limiter.tryConsume(1)).toBe(false);
      // 50 ms × 100 tokens/s = 5 tokens, capped at capacity=3.
      vi.advanceTimersByTime(50);
      expect(limiter.tryConsume(1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes to disallowed roles are rejected and logged', async () => {
    const audit = new MemoryAuditSink();
    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
      authenticate: () => ({ userId: 'viewer-1', role: 'viewer' }),
      auditSink: audit,
    });
    const port = (handle.httpServer.address() as { port: number }).port;
    const url = `ws://127.0.0.1:${port}`;

    const doc = new Y.Doc();
    const prov = new WebsocketProvider(url, 'room-z', doc, {
      WebSocketPolyfill: WebSocket as never,
      disableBc: true,
    });
    await new Promise<void>((r) => (prov.synced ? r() : prov.once('sync', () => r())));

    doc.getMap('m').set('forbidden', 1);
    // Allow the message to round-trip.
    await new Promise((r) => setTimeout(r, 100));

    const rejects = audit.entries.filter((e) => e.opType === 'reject');
    expect(rejects.some((e) => (e.detail as { reason?: string } | undefined)?.reason === 'role')).toBe(true);

    prov.destroy();
    await handle.stop();
  }, 10_000);

  it('rate limit drops bursts beyond budget', async () => {
    const audit = new MemoryAuditSink();
    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
      auditSink: audit,
      // Tiny budget so the test deterministically trips it.
      rateLimit: { capacity: 2, refillPerSecond: 0.0001 },
    });
    const port = (handle.httpServer.address() as { port: number }).port;
    const url = `ws://127.0.0.1:${port}`;

    const doc = new Y.Doc();
    const prov = new WebsocketProvider(url, 'room-rl', doc, {
      WebSocketPolyfill: WebSocket as never,
      disableBc: true,
    });
    await new Promise<void>((r) => (prov.synced ? r() : prov.once('sync', () => r())));

    const m = doc.getMap('m');
    for (let i = 0; i < 20; i++) m.set(`k${i}`, i);
    await new Promise((r) => setTimeout(r, 200));

    const rateLimited = audit.entries.filter(
      (e) => e.opType === 'reject' && (e.detail as { reason?: string } | undefined)?.reason === 'rate-limit',
    );
    expect(rateLimited.length).toBeGreaterThan(0);

    prov.destroy();
    await handle.stop();
  }, 10_000);
});
