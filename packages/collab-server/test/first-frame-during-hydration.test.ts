/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A websocket client talks first: y-websocket sends sync step 1 the moment the
 * socket opens. On a cold room the server is still awaiting authentication and
 * the room's log read, so the frame has to be held, not dropped.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import {
  holdFramesUntilAttached,
  MAX_PENDING_BYTES,
  MAX_PENDING_FRAMES,
} from '../src/connection.js';
import { FilePersistence, startCollabServer, type CollabServerHandle } from '../src/server.js';
import { MetricsRegistry } from '../src/metrics.js';

const LOAD_DELAY_MS = 400;
const SYNC_BUDGET_MS = 3000;

/** A file-backed store whose log read takes `delayMs`, standing in for a large log. */
class SlowFilePersistence extends FilePersistence {
  constructor(dataDir: string, private readonly delayMs: number) {
    super({ dataDir });
  }
  override async load(roomId: string): Promise<Uint8Array | null> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return super.load(roomId);
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function seededServer(
  extra: Partial<Parameters<typeof startCollabServer>[0]> = {},
): Promise<{ url: string; handle: CollabServerHandle }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-first-frame-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const persistence = new SlowFilePersistence(dir, LOAD_DELAY_MS);
  const seed = new Y.Doc();
  seed.getMap('test').set('persisted', 'on-disk');
  await persistence.append('cold-room', Y.encodeStateAsUpdate(seed));
  const handle = await startCollabServer({ port: 0, persistence, ...extra });
  cleanups.push(() => handle.stop());
  const address = handle.httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `ws://127.0.0.1:${port}`, handle };
}

/** Milliseconds until the provider reports `synced`, or `null` past the budget. */
async function timeToSync(url: string, doc: Y.Doc, budgetMs: number): Promise<number | null> {
  const started = Date.now();
  const provider = new WebsocketProvider(url, 'cold-room', doc, {
    WebSocketPolyfill: WebSocket as never,
    disableBc: true,
  });
  cleanups.push(() => provider.destroy());
  while (!provider.synced) {
    if (Date.now() - started > budgetMs) return null;
    await new Promise((r) => setTimeout(r, 10));
  }
  return Date.now() - started;
}

describe('first client frame during room hydration', () => {
  it('syncs a real y-websocket client against a cold, slow-loading room', async () => {
    const { url } = await seededServer();
    const doc = new Y.Doc();
    const ms = await timeToSync(url, doc, SYNC_BUDGET_MS);
    expect(ms, 'client never reached synced').not.toBeNull();
    expect(doc.getMap('test').get('persisted')).toBe('on-disk');
  }, 15_000);

  it('control: the same client syncs at once when the room is already loaded', async () => {
    const { url, handle } = await seededServer();
    await handle.roomManager.getOrCreate('cold-room');
    const doc = new Y.Doc();
    const ms = await timeToSync(url, doc, SYNC_BUDGET_MS);
    expect(ms).not.toBeNull();
    expect(ms!).toBeLessThan(LOAD_DELAY_MS);
    expect(doc.getMap('test').get('persisted')).toBe('on-disk');
  }, 15_000);
});

describe('a peer that leaves while its room hydrates', () => {
  it('is not registered as a ghost peer once the room finishes loading', async () => {
    const { url, handle } = await seededServer();
    const ws = new WebSocket(`${url}/cold-room`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.close();
    await new Promise((r) => ws.once('close', r));
    // Let the slow load finish and the server act on the dead socket.
    await new Promise((r) => setTimeout(r, LOAD_DELAY_MS + 300));
    const room = await handle.roomManager.getOrCreate('cold-room');
    expect(room.peerCount).toBe(0);
  }, 15_000);
});

describe('a held frame the room cannot process', () => {
  it('still tears the peer down when the replay throws', async () => {
    const { url, handle } = await seededServer({
      verifyMessage: () => { throw new Error('verifier blew up'); },
    });
    const ws = new WebSocket(`${url}/cold-room`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(new Uint8Array([0, 0, 1, 0]));
    await new Promise((r) => ws.once('close', r));
    await new Promise((r) => setTimeout(r, 100)); // the server's own close event
    const room = await handle.roomManager.getOrCreate('cold-room');
    expect(room.peerCount).toBe(0);
  }, 15_000);
});

describe('pre-ready buffer overflow through a real server', () => {
  it('closes 1009 and counts reason hydration-buffer on the rejects metric', async () => {
    const metrics = new MetricsRegistry();
    const { url } = await seededServer({ metrics });
    const ws = new WebSocket(`${url}/cold-room`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const closed = new Promise<number>((r) => ws.once('close', (code: number) => r(code)));
    for (let i = 0; i <= MAX_PENDING_FRAMES; i++) ws.send(new Uint8Array([9, 9]));
    expect(await closed).toBe(1009);
    expect(metrics.render()).toMatch(/collab_rejects_total\{reason="hydration-buffer"\} 1/);
  }, 15_000);
});

describe('holdFramesUntilAttached', () => {
  function fakeSocket() {
    const ee = new EventEmitter() as EventEmitter & { close: (code: number, reason: string) => void };
    const closed: Array<[number, string]> = [];
    ee.close = (code, reason) => { closed.push([code, reason]); };
    return { ws: ee as unknown as WebSocket, ee, closed };
  }
  const frame = (n: number, size = 1) => new Uint8Array(size).fill(n).buffer;

  it('replays held frames in arrival order, then delivers later ones directly', () => {
    const { ws, ee } = fakeSocket();
    const inbox = holdFramesUntilAttached(ws, () => { throw new Error('unexpected overflow'); });
    ee.emit('message', frame(1));
    ee.emit('message', frame(2));
    const seen: number[] = [];
    inbox.attach((b) => seen.push(b[0]));
    ee.emit('message', frame(3));
    expect(seen).toEqual([1, 2, 3]);
  });

  it('closes 1009 and counts once when the frame cap is exceeded', () => {
    const { ws, ee, closed } = fakeSocket();
    let overflows = 0;
    const inbox = holdFramesUntilAttached(ws, () => { overflows++; });
    for (let i = 0; i <= MAX_PENDING_FRAMES + 3; i++) ee.emit('message', frame(i));
    expect(overflows).toBe(1);
    expect(closed).toEqual([[1009, 'hydration-buffer-overflow']]);
    const seen: number[] = [];
    inbox.attach((b) => seen.push(b[0]));
    expect(seen).toEqual([]);
  });

  it('closes 1009 when the byte cap is exceeded', () => {
    const { ws, ee, closed } = fakeSocket();
    let overflows = 0;
    holdFramesUntilAttached(ws, () => { overflows++; });
    ee.emit('message', frame(1, MAX_PENDING_BYTES));
    expect(overflows).toBe(0);
    ee.emit('message', frame(2));
    expect(overflows).toBe(1);
    expect(closed).toHaveLength(1);
  });

  it('holds exactly MAX_PENDING_FRAMES frames and refuses the next', () => {
    const { ws, ee, closed } = fakeSocket();
    const inbox = holdFramesUntilAttached(ws, () => {});
    for (let i = 0; i < MAX_PENDING_FRAMES; i++) ee.emit('message', frame(i));
    expect(closed).toEqual([]);
    const seen: number[] = [];
    inbox.attach((b) => seen.push(b[0]));
    expect(seen).toHaveLength(MAX_PENDING_FRAMES);

    const second = fakeSocket();
    holdFramesUntilAttached(second.ws, () => {});
    for (let i = 0; i <= MAX_PENDING_FRAMES; i++) second.ee.emit('message', frame(i));
    expect(second.closed).toHaveLength(1);
  });
});
