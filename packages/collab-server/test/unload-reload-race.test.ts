/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unloading a room must not race the next load of the same room (PR #9489).
 *
 * `Room.destroy()` ends with a final compaction that REPLACES the persisted
 * log with the old doc's state (FilePersistence: write tmp + rename; Redis:
 * SET snapshot + LTRIM log; S3: PUT snapshot + delete log objects). A fresh
 * instance of the room loaded while that compaction is still in flight can
 * append an update that the compaction then wipes. And `sweepIdle()` used to
 * pick its candidates up front and unload them one by one, so a room a peer
 * joined meanwhile was unloaded anyway, which is exactly how the reload
 * starts. Each test forces its interleaving with a gate on `compact()`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { FilePersistence, MemoryPersistence, startCollabServer } from '../src/server.js';
import { RoomManager, type PeerConnection } from '../src/room-manager.js';

interface Gate {
  /** Resolves when compact(room) has been entered and is held. */
  entered: Promise<void>;
  release(): void;
}

function gate(): Gate & { enter(): Promise<void> } {
  let release!: () => void;
  let enter!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (enter = r));
  return {
    entered,
    release,
    async enter() {
      enter();
      await released;
    },
  };
}

/** File persistence whose compaction of one room waits on a gate. */
class GatedFilePersistence extends FilePersistence {
  readonly appends: Promise<void>[] = [];
  constructor(dataDir: string, private readonly gates: Map<string, ReturnType<typeof gate>>) {
    super({ dataDir });
  }
  override append(roomId: string, update: Uint8Array): Promise<void> {
    const p = super.append(roomId, update);
    this.appends.push(p);
    return p;
  }
  override async compact(roomId: string, merged: Uint8Array): Promise<void> {
    const g = this.gates.get(roomId);
    if (g) {
      this.gates.delete(roomId);
      await g.enter();
    }
    await super.compact(roomId, merged);
  }
}

function stubPeer(): { conn: PeerConnection; closes: number[] } {
  const closes: number[] = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: () => {},
    close: () => closes.push(Date.now()),
    terminate: () => {},
  } as unknown as import('ws').WebSocket;
  return { conn: { ws, principal: { userId: 'u', role: 'editor' }, awarenessClients: new Set() }, closes };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-unload-race-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('unload vs reload of the same room (PR #9489)', () => {
  it('PR #9489: an update made by the reloaded room survives the old instance\'s final compaction', async () => {
    const dir = tmpDir();
    const gates = new Map([['r', gate()]]);
    const held = gates.get('r')!;
    const persistence = new GatedFilePersistence(dir, gates);
    const mgr = new RoomManager({ persistence });
    cleanups.push(() => mgr.unloadAll());

    const first = await mgr.getOrCreate('r');
    first.doc.getMap('m').set('before', 1);
    await Promise.all(persistence.appends);

    const unloading = mgr.unload('r');
    await held.entered; // old instance's compaction captured {before} and is held

    // A client reconnects and writes U. Whether the manager hands it the new
    // instance now or only after the old one is gone, U must end up on disk.
    const reloaded = mgr.getOrCreate('r').then((room) => {
      room.doc.getMap('m').set('after', 2);
      return room;
    });
    await new Promise((r) => setTimeout(r, 50));
    held.release();
    await unloading;
    const second = await reloaded;
    await Promise.all(persistence.appends);

    expect(second).not.toBe(first);
    const onDisk = new Y.Doc();
    const saved = await new FilePersistence({ dataDir: dir }).load('r');
    if (saved) Y.applyUpdate(onDisk, saved);
    expect(onDisk.getMap('m').toJSON()).toEqual({ before: 1, after: 2 });
  });

  it('PR #9489: sweepIdle re-checks each candidate: a room joined while an earlier one compacts stays loaded', async () => {
    const gates = new Map([['a', gate()]]);
    const held = gates.get('a')!;
    const persistence = new MemoryPersistence();
    const realCompact = persistence.compact.bind(persistence);
    persistence.compact = async (roomId, merged) => {
      const g = gates.get(roomId);
      if (g) {
        gates.delete(roomId);
        await g.enter();
      }
      await realCompact(roomId, merged);
    };
    const mgr = new RoomManager({ persistence, idleUnloadMs: 20 });
    cleanups.push(() => mgr.unloadAll());
    await mgr.getOrCreate('a');
    await mgr.getOrCreate('b');
    await new Promise((r) => setTimeout(r, 40)); // both idle

    const sweep = mgr.sweepIdle();
    await held.entered; // 'a' is compacting; 'b' is next in line

    const b = await mgr.getOrCreate('b');
    const peer = stubPeer();
    b.addConnection(peer.conn);

    held.release();
    expect(await sweep).toEqual(['a']);
    expect(mgr.list()).toEqual(['b']);
    expect(peer.closes).toEqual([]);
    expect(b.peerCount).toBe(1);
  });

  it('PR #9489: unloadAll during a sweep waits for every compaction, including the one the sweep holds', async () => {
    // Review thread on #9489: could shutdown resolve while a sweep-started
    // compaction is still writing? Interleave exactly that.
    const gates = new Map([['a', gate()]]);
    const held = gates.get('a')!;
    const compacted: string[] = [];
    const persistence = new MemoryPersistence();
    const realCompact = persistence.compact.bind(persistence);
    persistence.compact = async (roomId, merged) => {
      const g = gates.get(roomId);
      if (g) {
        gates.delete(roomId);
        await g.enter();
      }
      await realCompact(roomId, merged);
      compacted.push(roomId);
    };
    const mgr = new RoomManager({ persistence, idleUnloadMs: 20 });
    for (const id of ['a', 'b', 'c']) await mgr.getOrCreate(id);
    await new Promise((r) => setTimeout(r, 40)); // all idle

    const sweep = mgr.sweepIdle();
    await held.entered; // sweep holds 'a'; 'b' and 'c' are its next candidates
    let shutDown = false;
    const all = mgr.unloadAll().then(() => {
      shutDown = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(shutDown).toBe(false); // 'a' is still writing

    held.release();
    await all;
    expect([...compacted].sort()).toEqual(['a', 'b', 'c']); // each exactly once
    expect(await sweep).toEqual(['a']); // the sweep skipped what unloadAll took
    expect(mgr.list()).toEqual([]);
  });

  it('PR #9489: a destroyed room refuses new connections instead of registering a ghost', async () => {
    const mgr = new RoomManager({ persistence: new MemoryPersistence() });
    cleanups.push(() => mgr.unloadAll());
    const room = await mgr.getOrCreate('gone');
    await mgr.unload('gone');
    const peer = stubPeer();
    expect(room.addConnection(peer.conn)).toBe(false);
    expect(room.peerCount).toBe(0);
  });

  it('PR #9489: a peer whose room is unloaded mid-join lands in the live reloaded room', async () => {
    // Slow load so the unload below lands while the peer's join is awaiting it.
    class SlowMemory extends MemoryPersistence {
      override async load(roomId: string): Promise<Uint8Array | null> {
        await new Promise((r) => setTimeout(r, 150));
        return super.load(roomId);
      }
    }
    const handle = await startCollabServer({ port: 0, host: '127.0.0.1', persistence: new SlowMemory() });
    cleanups.push(() => handle.stop());
    const ws = new WebSocket(`${handle.url}/mid-join`);
    cleanups.push(() => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    // Wait until the join has started loading the room, then unload it.
    while (!handle.roomManager.list().includes('mid-join')) await new Promise((r) => setTimeout(r, 5));
    const stale = handle.roomManager.peek('mid-join')!;
    await handle.roomManager.unload('mid-join');

    // The peer gets its sync step 1 from whichever room it was registered in.
    await new Promise<void>((resolve) => ws.once('message', () => resolve()));
    const live = handle.roomManager.peek('mid-join');
    expect(live).toBeDefined();
    expect(live).not.toBe(stale);
    expect((await live!).peerCount).toBe(1);
    expect(ws.readyState).toBe(ws.OPEN);
  });
});
