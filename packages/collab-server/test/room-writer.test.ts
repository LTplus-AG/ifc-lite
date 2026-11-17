/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A room's persistence writes run one at a time and stay bounded (PR #9489).
 * Every test drives a real `RoomManager` room and holds a backend call open
 * to force the interleaving.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MemoryPersistence } from '../src/persistence.js';
import { RoomManager } from '../src/room-manager.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Memory persistence with call counters and one-shot holds on append/compact. */
class HeldPersistence extends MemoryPersistence {
  appendCalls = 0;
  compactCalls = 0;
  failCompact = false;
  private holds = new Map<'append' | 'compact', { entered: () => void; released: Promise<void> }>();

  /** Hold the NEXT call of `kind` until `release` is called. */
  hold(kind: 'append' | 'compact'): { entered: Promise<void>; release: () => void } {
    let entered!: () => void;
    let release!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    const released = new Promise<void>((r) => (release = r));
    this.holds.set(kind, { entered, released });
    return { entered: enteredP, release };
  }

  private async gate(kind: 'append' | 'compact'): Promise<void> {
    const h = this.holds.get(kind);
    if (!h) return;
    this.holds.delete(kind);
    h.entered();
    await h.released;
  }

  override async append(roomId: string, update: Uint8Array): Promise<void> {
    this.appendCalls++;
    await this.gate('append');
    await super.append(roomId, update);
  }

  override async compact(roomId: string, merged: Uint8Array): Promise<void> {
    this.compactCalls++;
    await this.gate('compact');
    if (this.failCompact) throw new Error('compact failed: simulated');
    await super.compact(roomId, merged);
  }
}

async function onDisk(p: MemoryPersistence, roomId: string): Promise<Record<string, unknown>> {
  const doc = new Y.Doc();
  const saved = await p.load(roomId);
  if (saved) Y.applyUpdate(doc, saved);
  return doc.getMap('m').toJSON();
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await tick(5);
  }
}

describe('room persistence writes (PR #9489)', () => {
  it('PR #9489: the next append does not start until the running compaction resolves', async () => {
    const p = new HeldPersistence();
    const mgr = new RoomManager({ persistence: p, compactEvery: 1 });
    const room = await mgr.getOrCreate('serial');
    const held = p.hold('compact');
    room.doc.getMap('m').set('first', 1); // append, then compaction (held)
    await held.entered;
    room.doc.getMap('m').set('second', 2);
    await tick();
    expect(p.appendCalls).toBe(1); // 'second' waits behind the compaction
    held.release();
    await until(() => p.appendCalls === 2, 'second append');
    await mgr.unloadAll();
    expect(await onDisk(p, 'serial')).toEqual({ first: 1, second: 2 });
  });

  it('PR #9489: a burst behind a slow write coalesces into ONE pending append and every update lands', async () => {
    const N = 50;
    const p = new HeldPersistence();
    // No compaction in play: the appends alone must carry every update.
    const mgr = new RoomManager({ persistence: p, compactEvery: 1000 });
    const room = await mgr.getOrCreate('burst');
    const held = p.hold('append');
    room.doc.getMap('m').set('k0', 0);
    await held.entered;
    for (let i = 1; i < N; i++) room.doc.getMap('m').set(`k${i}`, i);
    await tick();
    expect(p.appendCalls).toBe(1); // nothing else started while held
    held.release();
    await until(() => p.appendCalls === 2, 'the coalesced append');
    await tick();
    // The 49 updates queued behind the held append went out as ONE append.
    expect(p.appendCalls).toBe(2);
    expect(p.compactCalls).toBe(0);
    const expected = Object.fromEntries(Array.from({ length: N }, (_, i) => [`k${i}`, i]));
    expect(await onDisk(p, 'burst')).toEqual(expected);
    await mgr.unloadAll();
  });

  it('PR #9489: unload drops the queued append (the final compaction holds it) and loses nothing', async () => {
    const p = new HeldPersistence();
    const mgr = new RoomManager({ persistence: p, compactEvery: 1000 });
    const room = await mgr.getOrCreate('drop');
    const held = p.hold('append');
    room.doc.getMap('m').set('inflight', 1);
    await held.entered;
    room.doc.getMap('m').set('queued-a', 2);
    room.doc.getMap('m').set('queued-b', 3);
    const unloading = mgr.unload('drop');
    await tick();
    held.release();
    await unloading;
    expect(p.appendCalls).toBe(1); // the queued append never ran
    expect(p.compactCalls).toBe(1); // the final compaction did
    expect(await onDisk(p, 'drop')).toEqual({ inflight: 1, 'queued-a': 2, 'queued-b': 3 });
  });

  it('PR #9489: if the final compaction fails, the dropped updates still reach disk as a full-state append', async () => {
    const p = new HeldPersistence();
    const mgr = new RoomManager({ persistence: p, compactEvery: 1000 });
    const room = await mgr.getOrCreate('fallback');
    const held = p.hold('append');
    room.doc.getMap('m').set('inflight', 1);
    await held.entered;
    room.doc.getMap('m').set('queued', 2);
    p.failCompact = true;
    const unloading = mgr.unload('fallback');
    await tick();
    held.release();
    await unloading;
    expect(await onDisk(p, 'fallback')).toEqual({ inflight: 1, queued: 2 });
  });
});
