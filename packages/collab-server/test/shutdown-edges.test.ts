/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Edge cases of the bounded shutdown in `stop()` (PR #9486): a room that
 * fails to load mid-shutdown, a join still authenticating when shutdown
 * starts, and a peer that never answers the close handshake.
 */

import * as net from 'node:net';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MemoryPersistence, startCollabServer } from '../src/server.js';
import { SHUTDOWN_GRACE_MS } from '../src/shutdown.js';
import type { Principal } from '../src/auth.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open a raw peer and wait for the room's sync step 1, i.e. it is registered. */
async function attachPeer(url: string, roomId: string): Promise<{ ws: WebSocket; closed: Promise<number> }> {
  const ws = new WebSocket(`${url}/${roomId}`);
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once('message', () => resolve());
    ws.once('error', reject);
  });
  return { ws, closed };
}

describe('collab server shutdown edges (PR #9486)', () => {
  it('PR #9486: a room failing to load during stop() still lets every other room compact and every socket drain; stop() then reports the failure', async () => {
    const compacted: string[] = [];
    class Persistence extends MemoryPersistence {
      override async load(roomId: string): Promise<Uint8Array | null> {
        if (roomId === 'broken') {
          await sleep(50);
          throw new Error('EMFILE: simulated');
        }
        return super.load(roomId);
      }
      override async compact(roomId: string, merged: Uint8Array): Promise<void> {
        await sleep(150); // still writing when the broken load rejects
        await super.compact(roomId, merged);
        compacted.push(roomId);
      }
    }
    // A join parked in auth for the whole stop(): only the drain step that
    // follows the unload can close it.
    let releaseAuth!: () => void;
    const authHeld = new Promise<void>((r) => (releaseAuth = r));
    const handle = await startCollabServer({
      port: 0,
      host: '127.0.0.1',
      persistence: new Persistence(),
      authenticate: async (_token, roomId): Promise<Principal> => {
        if (roomId === 'parked') await authHeld;
        return { userId: 'u', role: 'editor' };
      },
    });
    const good = await attachPeer(handle.url, 'good');
    const parked = new WebSocket(`${handle.url}/parked`);
    const parkedClosed = new Promise<number>((resolve) => parked.once('close', (code) => resolve(code)));
    await new Promise<void>((resolve) => parked.once('open', () => resolve()));
    const joining = new WebSocket(`${handle.url}/broken`);
    joining.on('error', () => {});
    while (!handle.roomManager.list().includes('broken')) await sleep(5);

    const outcome = await handle.stop().then(
      () => 'resolved',
      (err: unknown) => err,
    );
    expect(outcome).toBeInstanceOf(Error);
    // Everything after the failed room still ran before stop() settled.
    expect(compacted).toEqual(['good']);
    expect(handle.wss.clients.size).toBe(0);
    expect(handle.httpServer.listening).toBe(false);
    expect(await good.closed).toBeGreaterThan(0);
    expect(await parkedClosed).toBe(1001);
    releaseAuth();
    // The failure is memoized: a second stop() reports it again, no hang.
    await expect(handle.stop()).rejects.toBe(outcome);
    joining.terminate();
  });

  it('PR #9486: a join still authenticating when stop() starts is refused (1011) and leaves no room behind', async () => {
    let releaseAuth!: () => void;
    const authHeld = new Promise<void>((r) => (releaseAuth = r));
    let authEntered!: () => void;
    const entered = new Promise<void>((r) => (authEntered = r));
    class SlowCompact extends MemoryPersistence {
      override async compact(roomId: string, merged: Uint8Array): Promise<void> {
        await sleep(150); // keep stop() busy unloading while the join resumes
        await super.compact(roomId, merged);
      }
    }
    const handle = await startCollabServer({
      port: 0,
      host: '127.0.0.1',
      persistence: new SlowCompact(),
      authenticate: async (_token, roomId): Promise<Principal> => {
        if (roomId === 'late') {
          authEntered();
          await authHeld;
        }
        return { userId: 'u', role: 'editor' };
      },
    });
    const busy = await attachPeer(handle.url, 'busy');
    const late = new WebSocket(`${handle.url}/late`);
    const lateClosed = new Promise<number>((resolve) => late.once('close', (code) => resolve(code)));
    await entered;

    const stopping = handle.stop();
    releaseAuth(); // the join reaches getOrCreate while rooms are unloading
    await stopping;
    expect(await lateClosed).toBe(1011);
    expect(handle.roomManager.list()).toEqual([]);
    busy.ws.terminate();
  });

  it('PR #9486: a peer that never answers the close handshake is cut off after the grace period', async () => {
    const handle = await startCollabServer({ port: 0, host: '127.0.0.1', persistence: new MemoryPersistence() });
    const { port } = handle.httpServer.address() as net.AddressInfo;
    // A hand-rolled client: completes the upgrade, then never reads again,
    // so the server's close frame is never answered.
    const sock = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => sock.once('connect', () => resolve()));
    sock.write(
      'GET /silent HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await new Promise<void>((resolve) => sock.once('data', () => resolve()));
    while (!handle.roomManager.list().includes('silent')) await sleep(5);
    sock.pause();

    const started = Date.now();
    await handle.stop();
    const took = Date.now() - started;
    // Not ws's own 30s close timeout: our grace, plus slack.
    expect(took).toBeLessThan(SHUTDOWN_GRACE_MS + 1_500);
    expect(handle.wss.clients.size).toBe(0);
    sock.destroy();
  }, 15_000);
});
