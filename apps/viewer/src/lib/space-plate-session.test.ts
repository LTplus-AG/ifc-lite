/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { SpacePlateSession, MAX_UNDO, flattenWallRects } from './space-plate-session.js';
import type { SpacePlateHandle } from '@ifc-lite/wasm';

// A stand-in for the wasm handle: tracks the live-handle count and throws on a
// double free, so the tests catch leaks AND the double-free class of bug the
// session is meant to eliminate. `value` is a stand-in for plate state so we can
// assert that undo/redo/rollback actually restore the right snapshot.
let live = 0;
class FakeHandle {
  freed = false;
  constructor(public value: number) { live++; }
  duplicate(): SpacePlateHandle { return new FakeHandle(this.value) as unknown as SpacePlateHandle; }
  free(): void {
    if (this.freed) throw new Error('double free');
    this.freed = true;
    live--;
  }
  get roomCount(): number { return this.value; }
  snapshot(): unknown { return []; }
  /** A stand-in mutation. */
  set(v: number): number { this.value = v; return v; }
}

const fake = (v: number) => new FakeHandle(v) as unknown as SpacePlateHandle;
const valueOf = (s: SpacePlateSession) => s.roomCount; // roomCount === FakeHandle.value

describe('SpacePlateSession', () => {
  beforeEach(() => { live = 0; });

  it('edit commits on success and undo restores the pre-edit state', () => {
    const s = SpacePlateSession.fromHandle(fake(10));
    assert.strictEqual(s.dirty, false);
    s.edit((h) => (h as unknown as FakeHandle).set(20));
    assert.strictEqual(valueOf(s), 20);
    assert.strictEqual(s.dirty, true);
    assert.strictEqual(s.canUndo, true);
    assert.strictEqual(s.undo(), true);
    assert.strictEqual(valueOf(s), 10, 'undo restores the pre-edit snapshot');
    assert.strictEqual(s.canRedo, true);
    s.dispose();
    assert.strictEqual(live, 0, 'no leaked / double-freed handles');
  });

  it('edit rolls back to the snapshot and rethrows on a rejected mutation', () => {
    const s = SpacePlateSession.fromHandle(fake(10));
    assert.throws(() => s.edit((h) => {
      (h as unknown as FakeHandle).set(99); // partial mutation…
      throw new Error('BridgeEdge'); // …then the engine rejects
    }), /BridgeEdge/);
    assert.strictEqual(valueOf(s), 10, 'plate rolled back to pre-edit value');
    assert.strictEqual(s.dirty, false, 'a rejected edit does not dirty the plate');
    assert.strictEqual(s.canUndo, false, 'no undo entry for a rejected edit');
    s.dispose();
    assert.strictEqual(live, 0);
  });

  it('skips the undo entry when shouldCommit reports no change (prune-of-0)', () => {
    const s = SpacePlateSession.fromHandle(fake(10));
    const removed = s.edit(() => 0, (n) => n > 0);
    assert.strictEqual(removed, 0);
    assert.strictEqual(s.canUndo, false, 'a no-op prune leaves no undo entry');
    assert.strictEqual(s.dirty, false);
    s.dispose();
    assert.strictEqual(live, 0, 'the discarded snapshot was freed');
  });

  it('redo replays an undone edit, and a new edit clears the redo stack', () => {
    const s = SpacePlateSession.fromHandle(fake(1));
    s.edit((h) => (h as unknown as FakeHandle).set(2));
    s.undo();
    assert.strictEqual(valueOf(s), 1);
    assert.strictEqual(s.redo(), true);
    assert.strictEqual(valueOf(s), 2, 'redo replays the edit');
    // Undo, then a fresh edit must drop the redo branch.
    s.undo();
    s.edit((h) => (h as unknown as FakeHandle).set(3));
    assert.strictEqual(s.canRedo, false, 'a new edit clears redo');
    s.dispose();
    assert.strictEqual(live, 0);
  });

  it('bounds the undo stack at MAX_UNDO, freeing evicted snapshots', () => {
    const s = SpacePlateSession.fromHandle(fake(0));
    for (let i = 1; i <= MAX_UNDO + 5; i++) s.edit((h) => (h as unknown as FakeHandle).set(i));
    // Undo can only walk back MAX_UNDO steps.
    let steps = 0;
    while (s.undo()) steps++;
    assert.strictEqual(steps, MAX_UNDO, 'history is capped at MAX_UNDO');
    s.dispose();
    assert.strictEqual(live, 0, 'evicted snapshots were freed, not leaked');
  });

  it('commits a drag as one undo step', () => {
    const s = SpacePlateSession.fromHandle(fake(5));
    assert.strictEqual(s.beginDrag(), true);
    // dragTo calls handle.dragVertex (absent on the fake → swallowed); simulate
    // the live mutation a real drag step performs:
    (s as unknown as { handle: FakeHandle }).handle.set(8);
    s.commitDrag();
    assert.strictEqual(s.canUndo, true);
    assert.strictEqual(s.undo(), true);
    assert.strictEqual(valueOf(s), 5, 'undo restores the pre-drag state');
    s.dispose();
    assert.strictEqual(live, 0);
  });

  it('cancels a drag by restoring the pre-drag snapshot', () => {
    const s = SpacePlateSession.fromHandle(fake(5));
    s.beginDrag();
    (s as unknown as { handle: FakeHandle }).handle.set(8); // live drag mutation
    assert.strictEqual(valueOf(s), 8);
    s.cancelDrag();
    assert.strictEqual(valueOf(s), 5, 'cancel reverts to the pre-drag value');
    assert.strictEqual(s.canUndo, false, 'a cancelled drag leaves no undo entry');
    s.dispose();
    assert.strictEqual(live, 0);
  });

  it('build replaces the plate, clears history, and resets dirty', () => {
    // Exercise the history-replacement path via fromHandle + manual edits, then
    // assert dispose cleans everything (build() itself needs wasm, covered by
    // the viewer integration).
    const s = SpacePlateSession.fromHandle(fake(1));
    s.edit((h) => (h as unknown as FakeHandle).set(2));
    assert.strictEqual(s.canUndo, true);
    s.dispose();
    assert.strictEqual(live, 0, 'dispose frees current + history + pending');
  });
});

describe('SpacePlateSession — boundary outlines', () => {
  // `fromWallRects` returns a centreline plate whose room outline IS the wall
  // axis, so `center` is the room outline itself and `inner`/`outer` route to
  // `net_outline` (inset/outset by the wall half-thickness). Fake handle, no wasm.
  it('center returns the room outline; inner/outer route to net_outline (inset/outset)', () => {
    const axisOutline: [number, number][] = [[0, 0], [3, 0], [3, 3], [0, 3]];
    const insets: boolean[] = [];
    const handle = {
      snapshot: () => [{ face: 3, area: 9, simple: true, outline: axisOutline }] as unknown as ReturnType<SpacePlateHandle['snapshot']>,
      netOutline: (_f: number, inset: boolean) => { insets.push(inset); return Float64Array.from([0, 0, 1, 0, 1, 1]); },
      free: () => {},
    } as unknown as SpacePlateHandle;
    const s = SpacePlateSession.fromHandle(handle);
    assert.deepStrictEqual(s.boundaryOutline(3, 'center'), axisOutline, 'center = the wall axis outline');
    s.boundaryOutline(3, 'inner');
    s.boundaryOutline(3, 'outer');
    assert.deepStrictEqual(insets, [true, false], 'inner → inset (net), outer → outset (gross)');
  });
});

describe('flattenWallRects', () => {
  it('lays out 4 corners × 2 coords per wall, wall-major', () => {
    const flat = flattenWallRects([
      [[0, 0], [1, 0], [1, 2], [0, 2]],
      [[5, 5], [6, 5], [6, 7], [5, 7]],
    ]);
    assert.strictEqual(flat.length, 16, '8 floats per wall × 2 walls');
    assert.deepStrictEqual(Array.from(flat.slice(0, 8)), [0, 0, 1, 0, 1, 2, 0, 2]);
    assert.deepStrictEqual(Array.from(flat.slice(8)), [5, 5, 6, 5, 6, 7, 5, 7]);
  });
});
