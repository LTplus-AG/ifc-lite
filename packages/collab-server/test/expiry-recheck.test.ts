/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Principal.expiresAt` re-check (#3441).
 *
 * `expiresAt` is documented in `auth.ts` as "checked again every 5 minutes
 * per spec" and is populated from a room token's `exp` claim, but nothing
 * ever compared it against the clock: an established session kept write
 * (and read/presence) access indefinitely past its credential's expiry.
 * These tests establish a session whose `Principal.expiresAt` is already in
 * the past and assert (a) a write frame is denied and (b) the periodic
 * sweep closes the socket. A control principal with a future — or absent —
 * `expiresAt` still writes and stays connected.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import { MemoryPersistence, startCollabServer, type CollabServerHandle } from '../src/server.js';
import { MemoryAuditSink } from '../src/audit-log.js';
import type { Principal } from '../src/auth.js';
import { closeExpiredConnections, sweepExpiredAcrossRooms } from '../src/principal-expiry.js';

async function waitFor(check: () => boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor(${label}) timed out`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function connect(url: string, room: string, doc: Y.Doc): WebsocketProvider {
  return new WebsocketProvider(url, room, doc, {
    WebSocketPolyfill: WebSocket as never,
    disableBc: true,
  });
}

function synced(p: WebsocketProvider): Promise<void> {
  return new Promise<void>((res) => (p.synced ? res() : p.once('sync', () => res())));
}

async function startWithPrincipal(
  audit: MemoryAuditSink,
  principal: Principal,
): Promise<{ handle: CollabServerHandle; url: string }> {
  const handle = await startCollabServer({
    port: 0,
    persistence: new MemoryPersistence(),
    authenticate: () => principal,
    auditSink: audit,
  });
  const port = (handle.httpServer.address() as { port: number }).port;
  return { handle, url: `ws://127.0.0.1:${port}` };
}

describe('Principal.expiresAt re-check', () => {
  it('does not claim a throwing socket close succeeded and reports the failure', () => {
    const expired: Principal = { userId: 'u-throwing-close', role: 'viewer', expiresAt: 0 };
    const reported: Array<{ kind: string; error: unknown }> = [];
    const closed = closeExpiredConnections(
      [{ principal: expired, ws: { close: () => { throw new Error('already destroyed'); } } as never }],
      Date.now(),
      (kind, error) => reported.push({ kind, error }),
    );

    expect(closed).toBe(0);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.kind).toBe('close');
    expect(reported[0]?.error).toBeInstanceOf(Error);
  });

  it('reports a rejected room load while still sweeping every room that loaded', async () => {
    const rejected = new Error('persistence unavailable');
    const reported: Array<{ kind: string; error: unknown }> = [];
    const swept: number[] = [];
    const closed = await sweepExpiredAcrossRooms(
      [
        Promise.reject(rejected),
        Promise.resolve({ sweepExpiredPrincipals: (now: number) => { swept.push(now); return 2; } }),
      ],
      123,
      (kind, error) => reported.push({ kind, error }),
    );

    expect(closed).toBe(2);
    expect(swept).toEqual([123]);
    expect(reported).toEqual([{ kind: 'room-load', error: rejected }]);
  });

  it('denies a write frame once expiresAt is in the past', async () => {
    const audit = new MemoryAuditSink();
    const expired: Principal = { userId: 'u-expired', role: 'editor', expiresAt: Date.now() - 60_000 };
    const { handle, url } = await startWithPrincipal(audit, expired);

    const doc = new Y.Doc();
    const prov = connect(url, 'room-expired-write', doc);
    await synced(prov);

    doc.getMap('m').set('should-be-denied', 1);
    await new Promise((r) => setTimeout(r, 150));

    // The write must not have been accepted.
    expect(audit.entries.some((e) => e.opType === 'update')).toBe(false);
    const rejects = audit.entries.filter((e) => e.opType === 'reject');
    expect(rejects.some((e) => (e.detail as { reason?: string } | undefined)?.reason === 'expired')).toBe(
      true,
    );

    prov.destroy();
    await handle.stop();
  }, 10_000);

  it('control: a principal with a future expiresAt still writes', async () => {
    const audit = new MemoryAuditSink();
    const future: Principal = { userId: 'u-future', role: 'editor', expiresAt: Date.now() + 60_000 };
    const { handle, url } = await startWithPrincipal(audit, future);

    const doc = new Y.Doc();
    const prov = connect(url, 'room-future-write', doc);
    await synced(prov);

    doc.getMap('m').set('should-succeed', 1);
    await waitFor(() => audit.entries.some((e) => e.opType === 'update'), 2000, 'update accepted');

    const rejects = audit.entries.filter(
      (e) => e.opType === 'reject' && (e.detail as { reason?: string } | undefined)?.reason === 'expired',
    );
    expect(rejects.length).toBe(0);

    prov.destroy();
    await handle.stop();
  }, 10_000);

  it('control: a principal with no expiresAt still writes', async () => {
    const audit = new MemoryAuditSink();
    const noExpiry: Principal = { userId: 'u-no-expiry', role: 'editor' };
    const { handle, url } = await startWithPrincipal(audit, noExpiry);

    const doc = new Y.Doc();
    const prov = connect(url, 'room-no-expiry-write', doc);
    await synced(prov);

    doc.getMap('m').set('should-succeed', 1);
    await waitFor(() => audit.entries.some((e) => e.opType === 'update'), 2000, 'update accepted');

    prov.destroy();
    await handle.stop();
  }, 10_000);

  it('periodic sweep closes a socket whose expiresAt has passed', async () => {
    const audit = new MemoryAuditSink();
    const expired: Principal = { userId: 'u-expired-sweep', role: 'viewer', expiresAt: Date.now() - 60_000 };
    const { handle, url } = await startWithPrincipal(audit, expired);

    const doc = new Y.Doc();
    const prov = connect(url, 'room-expired-sweep', doc);
    await synced(prov);
    expect(prov.wsconnected).toBe(true);

    // Drive the sweep directly rather than waiting the real 5-minute
    // interval — same code path `server.ts` runs on its timer.
    const closed = await handle.roomManager.sweepExpiredPrincipals();
    expect(closed).toBeGreaterThanOrEqual(1);

    await waitFor(() => !prov.wsconnected, 2000, 'socket closed by sweep');

    prov.destroy();
    await handle.stop();
  }, 10_000);

  it('control: the sweep leaves a not-yet-expired socket connected', async () => {
    const audit = new MemoryAuditSink();
    const future: Principal = { userId: 'u-future-sweep', role: 'viewer', expiresAt: Date.now() + 60_000 };
    const { handle, url } = await startWithPrincipal(audit, future);

    const doc = new Y.Doc();
    const prov = connect(url, 'room-future-sweep', doc);
    await synced(prov);

    const closed = await handle.roomManager.sweepExpiredPrincipals();
    expect(closed).toBe(0);

    await new Promise((r) => setTimeout(r, 100));
    expect(prov.wsconnected).toBe(true);

    prov.destroy();
    await handle.stop();
  }, 10_000);
});
