/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `stop()` must finish while peers are still connected (PR #9486).
 *
 * The WebSocketServer runs in `noServer` mode. In ws@8 its `close(cb)` neither
 * terminates clients nor calls back until every client has gone, and peers
 * here never go on their own (the app keepalive holds y-websocket open). The
 * old `stop()` awaited that callback BEFORE unloading rooms, which is the only
 * thing that closes peer sockets, so a SIGTERM with anyone connected never
 * resolved: no final compaction, and bin.ts never reached its access-control
 * `flush()`. These tests keep a real peer attached across `stop()`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { MemoryPersistence, startCollabServer } from '../src/server.js';
import { RoomManager } from '../src/room-manager.js';

class RecordingPersistence extends MemoryPersistence {
  readonly compacted: string[] = [];
  override async compact(roomId: string, merged: Uint8Array): Promise<void> {
    this.compacted.push(roomId);
    await super.compact(roomId, merged);
  }
}

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

function within<T>(p: Promise<T>, ms: number): Promise<T | 'timed-out'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

describe('collab server shutdown with live peers (PR #9486)', () => {
  it('PR #9486: stop() resolves with a peer attached, closes it, and runs the final compaction', async () => {
    const persistence = new RecordingPersistence();
    const handle = await startCollabServer({ port: 0, host: '127.0.0.1', persistence });
    const peer = await attachPeer(handle.url, 'live-room');
    try {
      const outcome = await within(handle.stop().then(() => 'stopped' as const), 3_000);
      expect(outcome).toBe('stopped');
      expect(persistence.compacted).toEqual(['live-room']);
      // The peer was told the server is going away, not left hanging.
      expect(await within(peer.closed, 1_000)).not.toBe('timed-out');
    } finally {
      peer.ws.terminate();
    }
  });

  it('PR #9486: stop() is idempotent: concurrent and repeated calls resolve and compact once', async () => {
    const persistence = new RecordingPersistence();
    const handle = await startCollabServer({ port: 0, host: '127.0.0.1', persistence });
    const peer = await attachPeer(handle.url, 'twice');
    try {
      const both = Promise.all([handle.stop(), handle.stop()]).then(() => 'stopped' as const);
      expect(await within(both, 3_000)).toBe('stopped');
      expect(await within(handle.stop().then(() => 'stopped' as const), 1_000)).toBe('stopped');
      expect(persistence.compacted).toEqual(['twice']);
    } finally {
      peer.ws.terminate();
    }
  });

  it('PR #9486: a peer upgrading after stop() began is refused, not registered into a dead room', async () => {
    const persistence = new RecordingPersistence();
    const handle = await startCollabServer({ port: 0, host: '127.0.0.1', persistence });
    const peer = await attachPeer(handle.url, 'r');
    const stopping = handle.stop();
    const late = new WebSocket(`${handle.url}/late-room`);
    const lateOutcome = new Promise<string>((resolve) => {
      late.once('message', () => resolve('registered'));
      late.once('error', () => resolve('refused'));
      late.once('close', () => resolve('refused'));
    });
    try {
      expect(await within(stopping.then(() => 'stopped' as const), 3_000)).toBe('stopped');
      expect(await within(lateOutcome, 2_000)).toBe('refused');
      expect(handle.roomManager.list()).toEqual([]);
    } finally {
      peer.ws.terminate();
      late.terminate();
    }
  });

  it('PR #9486: unloadAll() only evicts: the manager keeps loading rooms afterwards', async () => {
    const mgr = new RoomManager({ persistence: new MemoryPersistence() });
    const before = await mgr.getOrCreate('kept');
    before.doc.getMap('m').set('k', 1);
    await mgr.unloadAll();
    expect(mgr.list()).toEqual([]);
    const after = await mgr.getOrCreate('kept');
    expect(after).not.toBe(before);
    expect(after.doc.getMap('m').get('k')).toBe(1); // reloaded from persistence
    await mgr.unloadAll();
  });

  it('PR #9486: a running server whose rooms were evicted with unloadAll() still admits peers', async () => {
    const handle = await startCollabServer({ port: 0, host: '127.0.0.1', persistence: new MemoryPersistence() });
    const first = await attachPeer(handle.url, 'evicted');
    await handle.roomManager.unloadAll();
    await first.closed;
    const second = await attachPeer(handle.url, 'evicted');
    try {
      expect(handle.roomManager.list()).toEqual(['evicted']);
    } finally {
      second.ws.terminate();
      await handle.stop();
    }
  });

  it('PR #9486: after stop() the manager refuses to load rooms', async () => {
    const handle = await startCollabServer({ port: 0, host: '127.0.0.1', persistence: new MemoryPersistence() });
    await handle.stop();
    await expect(handle.roomManager.getOrCreate('late')).rejects.toThrow(/shut down/);
    expect(handle.roomManager.list()).toEqual([]);
  });

  it('PR #9486: unloadAll() lets every room finish its final compaction, logs every failure, then rethrows the first original error', async () => {
    const compacted: string[] = [];
    const loadErrors = new Map([
      ['broken-1', new Error('corrupt log: simulated 1')],
      ['broken-2', new Error('corrupt log: simulated 2')],
    ]);
    class Persistence extends MemoryPersistence {
      override async load(roomId: string): Promise<Uint8Array | null> {
        const err = loadErrors.get(roomId);
        if (err) {
          await new Promise((r) => setTimeout(r, 20));
          throw err;
        }
        return super.load(roomId);
      }
      override async compact(roomId: string, merged: Uint8Array): Promise<void> {
        await new Promise((r) => setTimeout(r, 80));
        await super.compact(roomId, merged);
        compacted.push(roomId);
      }
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mgr = new RoomManager({ persistence: new Persistence() });
    await mgr.getOrCreate('fine');
    const loads = ['broken-1', 'broken-2'].map((id) => mgr.getOrCreate(id).then(() => 'loaded', (e: unknown) => e));
    const err = await mgr.unloadAll().then(() => null, (e: unknown) => e);
    // Same contract as before: the original error object, not a wrapper.
    expect(err).toBe(loadErrors.get('broken-1'));
    expect(await Promise.all(loads)).toEqual([loadErrors.get('broken-1'), loadErrors.get('broken-2')]);
    expect(compacted).toEqual(['fine']);
    for (const e of loadErrors.values()) {
      expect(logged.mock.calls.some((args) => String(args[0]).includes('unload failed') && args.includes(e))).toBe(true);
    }
    // Still serving afterwards.
    await expect(mgr.getOrCreate('fine')).resolves.toBeDefined();
    await mgr.unloadAll();
  });

  it('PR #9486: the idle sweep keeps running after a public unloadAll()', async () => {
    vi.useFakeTimers();
    const mgr = new RoomManager({ persistence: new MemoryPersistence(), idleUnloadMs: 2_000 });
    await mgr.getOrCreate('before');
    await mgr.unloadAll();
    await mgr.getOrCreate('after');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mgr.list()).toEqual([]); // swept: the timer survived unloadAll()
    await mgr.shutdown();
  });

  it('PR #9486: stop() waits for a final compaction an idle sweep had already started', async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const holding = new Promise<void>((r) => (entered = r));
    const compacted: string[] = [];
    class Persistence extends MemoryPersistence {
      override async compact(roomId: string, merged: Uint8Array): Promise<void> {
        if (roomId === 'idle') {
          entered();
          await released;
        }
        await super.compact(roomId, merged);
        compacted.push(roomId);
      }
    }
    const handle = await startCollabServer({
      port: 0,
      host: '127.0.0.1',
      persistence: new Persistence(),
      idleUnloadMs: 20,
    });
    await handle.roomManager.getOrCreate('idle');
    await new Promise((r) => setTimeout(r, 40));
    const sweep = handle.roomManager.sweepIdle(); // removes 'idle' from the map, then compacts (held)
    await holding;
    expect(handle.roomManager.list()).toEqual([]);

    let stopped = false;
    const stopping = handle.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false); // still waiting on the sweep's compaction
    release();
    await stopping;
    expect(compacted).toEqual(['idle']);
    expect(await sweep).toEqual(['idle']);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
