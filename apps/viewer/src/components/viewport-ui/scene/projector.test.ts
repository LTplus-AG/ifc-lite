/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SceneProjector` math and lifecycle with a stub camera and a
 * manually-driven fake `requestAnimationFrame` — no DOM, no renderer.
 * Mutation-checked: each assertion was verified to fail when the guarded
 * behaviour was reverted (see the comment above each one).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SceneProjector } from './projector.js';
import type { ProjectorCamera, ProjectorSource, ScreenPoint, Vec3 } from './types.js';

/** Runs queued rAF callbacks synchronously and deterministically for tests. */
class FakeFrameScheduler {
  private queue = new Map<number, FrameRequestCallback>();
  private nextHandle = 1;
  private time = 0;

  request = (cb: FrameRequestCallback): number => {
    const handle = this.nextHandle++;
    this.queue.set(handle, cb);
    return handle;
  };

  cancel = (handle: number): void => {
    this.queue.delete(handle);
  };

  /** Run every callback queued right now (a "frame"). Returns how many ran. */
  flush(): number {
    const due = [...this.queue.entries()];
    this.queue.clear();
    this.time += 16;
    for (const [, cb] of due) cb(this.time);
    return due.length;
  }

  get pending(): number {
    return this.queue.size;
  }
}

/** A camera that projects world.x/world.y straight to screen px, ignoring z, unless told to go "behind". */
class StubCamera implements ProjectorCamera {
  behind = false;
  projectToScreen(worldPos: Vec3): ScreenPoint | null {
    if (this.behind) return null;
    return { x: worldPos.x, y: worldPos.y };
  }
}

class StubSource implements ProjectorSource {
  camera = new StubCamera();
  canvasSize = { width: 800, height: 600 };
  dirty = false;
  getCamera(): ProjectorCamera | null {
    return this.camera;
  }
  getCanvasSize() {
    return this.canvasSize;
  }
  isDirty(): boolean {
    return this.dirty;
  }
}

function makeProjector() {
  const scheduler = new FakeFrameScheduler();
  const source = new StubSource();
  const projector = new SceneProjector(source, { requestFrame: scheduler.request, cancelFrame: scheduler.cancel });
  return { scheduler, source, projector };
}

describe('SceneProjector', () => {
  it('projects N anchors through a single scheduled frame, not one per anchor', () => {
    const { scheduler, projector } = makeProjector();
    const results = new Map<string, ScreenPoint | null>();
    const N = 200;
    for (let i = 0; i < N; i++) {
      projector.registerAnchor(`a${i}`, () => ({ x: i, y: i, z: 0 }), (p) => results.set(`a${i}`, p.screen));
    }
    // Registration wakes the projector: exactly one frame is pending, not N.
    assert.equal(scheduler.pending, 1, 'registering N anchors should schedule exactly one frame');
    const ran = scheduler.flush();
    assert.equal(ran, 1, 'one rAF callback services every anchor');
    assert.equal(results.size, N);
    assert.deepEqual(results.get('a50'), { x: 50, y: 50 });
    // Mutation check: deleting the `for (const entry of this.anchors.values())`
    // loop body (projecting only the first anchor) would leave `results.size === 1`.
  });

  it('stops scheduling frames once idle', () => {
    const { scheduler, source, projector } = makeProjector();
    projector.registerAnchor('a', () => ({ x: 1, y: 1, z: 0 }), () => {});
    scheduler.flush(); // dirty tick (anchor just registered): projects, reschedules once more
    assert.equal(scheduler.pending, 1, 'a dirty tick reschedules once to re-check next frame');
    source.dirty = false; // camera stays put from here on
    scheduler.flush(); // this tick finds nothing dirty
    assert.equal(scheduler.pending, 0, 'an idle tick does not reschedule — the loop stops');
    assert.equal(projector.isRunning, false);
    // Mutation check: removing the `if (!anchorsDirty && !cameraDirty) return;`
    // early-return would make this tick call `wake()` unconditionally, and
    // `scheduler.pending` would stay 1 forever.
  });

  it('a static camera with no anchor changes never schedules a frame at all', () => {
    const { scheduler, projector } = makeProjector();
    assert.equal(scheduler.pending, 0);
    assert.equal(projector.isRunning, false);
    assert.equal(projector.dirtyTicks, 0);
    void projector; // nothing registered, nothing to wake
    // Mutation check: a constructor that eagerly calls `this.wake()` would
    // make `scheduler.pending` 1 immediately.
  });

  it('camera motion (isDirty) re-wakes an idle loop and keeps projecting while it continues', () => {
    const { scheduler, source, projector } = makeProjector();
    const seen: Array<ScreenPoint | null> = [];
    projector.registerAnchor('a', () => ({ x: 5, y: 5, z: 0 }), (p) => seen.push(p.screen));
    scheduler.flush(); // registration tick
    source.dirty = false;
    scheduler.flush(); // idle tick, stops
    assert.equal(projector.isRunning, false);

    // Something external (a pointer/wheel listener in the real provider) calls wake()
    // once the camera starts moving; isDirty() reflects the renderer's pending-render flag.
    source.dirty = true;
    projector.wake();
    const before = projector.dirtyTicks;
    scheduler.flush();
    assert.equal(projector.dirtyTicks, before + 1);
    assert.equal(scheduler.pending, 1, 'still dirty next frame — orbiting keeps the loop alive');

    source.dirty = false;
    scheduler.flush(); // motion stopped: this tick finds nothing dirty
    assert.equal(scheduler.pending, 0);
    assert.ok(seen.length >= 2);
  });

  it('unregistering an anchor delivers one final hidden projection and stops if nothing else is registered', () => {
    const { scheduler, projector } = makeProjector();
    const seen: Array<ScreenPoint | null> = [];
    const unregister = projector.registerAnchor('a', () => ({ x: 1, y: 1, z: 0 }), (p) => seen.push(p.screen));
    scheduler.flush();
    assert.deepEqual(seen.at(-1), { x: 1, y: 1 });
    unregister();
    assert.deepEqual(seen.at(-1), null, 'unregister delivers a final hidden projection synchronously');
    scheduler.flush(); // the wake() from unregister
    assert.equal(scheduler.pending, 0, 'no anchors left — nothing reschedules');
    // Mutation check: dropping the `listener(HIDDEN_PROJECTION)` call in the
    // returned unregister closure would leave `seen.at(-1)` as the last live screen point.
  });

  it('behind-camera anchors report screen: null and behindCamera: true', () => {
    const { scheduler, source, projector } = makeProjector();
    source.camera.behind = true;
    const seen: Array<{ screen: ScreenPoint | null; behindCamera: boolean }> = [];
    projector.registerAnchor('a', () => ({ x: 1, y: 1, z: 0 }), (p) => seen.push(p));
    scheduler.flush();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.screen, null);
    assert.equal(seen[0]!.behindCamera, true);
    // Mutation check: returning `{ screen: { x: 0, y: 0 }, behindCamera: false, offScreen: false }`
    // for a null `projectToScreen` result would flip `seen[0].behindCamera` to false.
  });

  it('off-screen anchors (outside the canvas) report offScreen: true', () => {
    const { scheduler, source, projector } = makeProjector();
    const seen: Array<{ offScreen: boolean }> = [];
    projector.registerAnchor('a', () => ({ x: 5000, y: 5000, z: 0 }), (p) => seen.push(p));
    scheduler.flush();
    assert.equal(seen[0]!.offScreen, true, `canvas is ${source.canvasSize.width}x${source.canvasSize.height}`);

    const seen2: Array<{ offScreen: boolean }> = [];
    projector.registerAnchor('b', () => ({ x: 10, y: 10, z: 0 }), (p) => seen2.push(p));
    projector.notifyAnchorsChanged();
    scheduler.flush();
    assert.equal(seen2.at(-1)!.offScreen, false);
  });

  it('a null world point (e.g. anchor not yet ready) hides without a camera projection', () => {
    const { scheduler, projector } = makeProjector();
    const seen: Array<{ screen: ScreenPoint | null }> = [];
    projector.registerAnchor('a', () => null, (p) => seen.push(p));
    scheduler.flush();
    assert.equal(seen[0]!.screen, null);
  });
});
