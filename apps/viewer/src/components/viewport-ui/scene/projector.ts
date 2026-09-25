/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SceneProjector`: the one `requestAnimationFrame` loop for every
 * world-anchored overlay primitive (#5486, charter #5478).
 *
 * Before this kernel, five components (the section drag gizmo and pick preview,
 * `BasepointOverlay`, `PeerPresenceLayer`, the BCF overlay renderer) each run
 * their own unconditional `requestAnimationFrame` + `projectToScreen` loop —
 * five timers doing the same matrix work forever, even when the camera has
 * not moved and nothing registered has changed. This kernel replaces all of
 * them with one loop that only runs while there is something to project.
 *
 * "Only while there is something to project" has two parts:
 *
 *  - **Idle detection.** Each tick checks `source.isDirty()` (a non-consuming
 *    peek at the renderer's pending-render flag — set by camera moves, model
 *    edits, anything that calls `requestRender()`) and whether any anchor was
 *    registered/unregistered since the last tick. If neither changed, the
 *    tick does no projection work and — the point of this class — does NOT
 *    schedule another frame. The loop goes fully idle: zero rAF callbacks
 *    fire until something wakes it.
 *  - **Waking up.** `registerAnchor`/`unregister` call `wake()`, so a newly
 *    mounted anchor projects immediately even with a static camera. Camera
 *    motion wakes the loop through its own channel: `wake()` is also the
 *    method `SceneProjectorProvider` calls from pointer/wheel listeners on
 *    the viewport canvas, because a stopped rAF loop cannot poll
 *    `isDirty()` to notice it should restart. A camera tween with no pointer
 *    event under it (e.g. a "Home" button click) needs its own `wake()`
 *    call at the call site — out of scope for this kernel PR, tracked by
 *    the migration items (#5510-#5512) that move existing gizmos onto this.
 *
 * Once woken, a dirty tick always schedules exactly one more tick to check
 * again — motion this frame doesn't guarantee motion next frame, and the
 * only way to find out is to look. So going idle costs exactly one "wasted"
 * tick after the camera settles: it finds nothing dirty and stops. That is
 * the bounded overhead this class accepts in exchange for "stops when idle"
 * instead of "runs forever".
 */

import type {
  AnchorProjection,
  CanvasSize,
  ProjectorCamera,
  ProjectorListener,
  ProjectorSource,
  Unregister,
  Vec3,
} from './types';
import { HIDDEN_PROJECTION } from './types';

interface AnchorEntry {
  getWorldPoint: () => Vec3 | null;
  listener: ProjectorListener;
}

export interface SceneProjectorOptions {
  source: ProjectorSource;
  /** Injectable for tests; defaults to the global `requestAnimationFrame`. */
  requestFrame?: (cb: FrameRequestCallback) => number;
  /** Injectable for tests; defaults to the global `cancelAnimationFrame`. */
  cancelFrame?: (handle: number) => void;
  /** Extra CSS-px margin outside the canvas still counted "on screen". Default 0. */
  offScreenMargin?: number;
}

export class SceneProjector {
  private readonly anchors = new Map<string, AnchorEntry>();
  private readonly requestFrame: (cb: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly offScreenMargin: number;

  private frameHandle: number | null = null;
  private anchorsVersion = 0;
  private lastCheckedVersion = -1;
  /** Ticks that actually did projection work — the "N anchors, one loop" measurement surface. */
  private dirtyTickCount = 0;

  constructor(private readonly source: ProjectorSource, options: Omit<SceneProjectorOptions, 'source'> = {}) {
    this.requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = options.cancelFrame ?? ((h) => cancelAnimationFrame(h));
    this.offScreenMargin = options.offScreenMargin ?? 0;
  }

  /** True while a frame is scheduled. */
  get isRunning(): boolean {
    return this.frameHandle !== null;
  }

  /** Number of ticks that ran projection work (excludes idle no-op ticks). Test/telemetry surface. */
  get dirtyTicks(): number {
    return this.dirtyTickCount;
  }

  get anchorCount(): number {
    return this.anchors.size;
  }

  /**
   * Register a world anchor. `getWorldPoint` is read fresh every dirty tick
   * (anchors that move with no separate "anchor changed" signal — e.g. a
   * point derived from live store state — are picked up automatically as
   * long as SOMETHING else keeps the loop dirty; a moving anchor whose only
   * driver is its own world point changing should also call
   * `notifyAnchorsChanged()` when it updates).
   */
  registerAnchor(id: string, getWorldPoint: () => Vec3 | null, listener: ProjectorListener): Unregister {
    this.anchors.set(id, { getWorldPoint, listener });
    this.anchorsVersion += 1;
    this.wake();
    return () => {
      if (!this.anchors.delete(id)) return;
      this.anchorsVersion += 1;
      // Immediately tell the removed listener it is hidden, in case a
      // consumer keeps a stale ref around after unmount.
      listener(HIDDEN_PROJECTION);
      this.wake();
    };
  }

  /** Call after mutating an anchor's world point out of band, to force a re-check even if the camera is static. */
  notifyAnchorsChanged(): void {
    this.anchorsVersion += 1;
    this.wake();
  }

  /** Schedule a tick if one isn't already pending. Idempotent. */
  wake(): void {
    if (this.frameHandle !== null) return;
    this.frameHandle = this.requestFrame((t) => this.tick(t));
  }

  /** Stop and discard any pending frame. For teardown (provider unmount). */
  stop(): void {
    if (this.frameHandle === null) return;
    this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
  }

  private tick(_time: number): void {
    this.frameHandle = null;

    const anchorsDirty = this.anchorsVersion !== this.lastCheckedVersion;
    this.lastCheckedVersion = this.anchorsVersion;
    const cameraDirty = this.source.isDirty();

    if (!anchorsDirty && !cameraDirty) {
      // Idle: nothing to project, and nothing schedules the next frame —
      // the loop stops here until `wake()` is called again.
      return;
    }

    this.dirtyTickCount += 1;
    const camera = this.source.getCamera();
    const canvasSize = this.source.getCanvasSize();

    for (const entry of this.anchors.values()) {
      entry.listener(this.project(entry.getWorldPoint(), camera, canvasSize));
    }

    // Still registered anchors and this tick was dirty: motion may
    // continue, so check again next frame. If it doesn't, that next tick
    // finds nothing dirty and the loop stops itself.
    if (this.anchors.size > 0) {
      this.wake();
    }
  }

  private project(worldPoint: Vec3 | null, camera: ProjectorCamera | null, canvasSize: CanvasSize | null): AnchorProjection {
    if (!worldPoint || !camera || !canvasSize || canvasSize.width <= 0 || canvasSize.height <= 0) {
      return HIDDEN_PROJECTION;
    }
    const screen = camera.projectToScreen(worldPoint, canvasSize.width, canvasSize.height);
    if (!screen) {
      return HIDDEN_PROJECTION;
    }
    const margin = this.offScreenMargin;
    const offScreen =
      screen.x < -margin ||
      screen.x > canvasSize.width + margin ||
      screen.y < -margin ||
      screen.y > canvasSize.height + margin;
    return { screen, behindCamera: false, offScreen };
  }
}
