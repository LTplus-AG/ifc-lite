/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adapts the live `@ifc-lite/renderer` `Renderer` to `ProjectorSource`
 * (#5486). Kept out of `projector.ts` so the core projector stays
 * renderer-free and unit-testable with a stub; this is the one file that
 * knows how to find the real camera and canvas, the way `BasepointOverlay`
 * did before #5501 moved the section gizmo here (`container.closest('[data-viewport]')`).
 *
 * `isDirty()` compares a camera-pose snapshot (position, rotation, distance,
 * canvas size) tick to tick — the exact fields and shape `useAnimationLoop`
 * already uses for its own "did the camera move" check before recomputing
 * measurement screen coords. It does NOT read `Renderer.peekRenderRequest()`:
 * that flag is shared with the main render loop, which runs an unconditional
 * per-frame rAF and calls `consumeRenderRequest()` on it every frame it's
 * already scheduled for. A reactively-woken projector tick (scheduled from a
 * pointer/wheel listener mid-frame) loses that race almost every time — its
 * `requestAnimationFrame` call lands after the main loop's already-pending
 * one in the same frame's callback queue, so by the time the projector reads
 * the flag the main loop has already cleared it. Measured live (orbiting the
 * FZK-Haus model, #5486 PR evidence): `peekRenderRequest()` read `true` 0 of
 * 35 times across a 30-frame drag that visibly rotated the camera. A pose
 * comparison has no such race — it doesn't share mutable state with another
 * reader.
 */

import { getGlobalRenderer } from '@/hooks/useBCF';
import type { CanvasSize, ProjectorCamera, ProjectorSource } from './types';

interface CameraSnapshot {
  position: { x: number; y: number; z: number };
  rotation: { azimuth: number; elevation: number };
  distance: number;
  width: number;
  height: number;
}

export class RendererProjectorSource implements ProjectorSource {
  private canvas: HTMLCanvasElement | null = null;
  private lastSnapshot: CameraSnapshot | null = null;

  constructor(
    private readonly containerRef: { current: HTMLElement | null },
    /** Fired the first time (or again, after a remount) the canvas is found — used to attach the wake-on-interaction listeners. */
    private readonly onCanvasResolved: (canvas: HTMLCanvasElement) => void,
  ) {}

  private resolveCanvas(): HTMLCanvasElement | null {
    if (this.canvas?.isConnected) return this.canvas;
    const container = this.containerRef.current;
    const found = (container?.closest('[data-viewport]')?.querySelector('canvas') ?? null) as HTMLCanvasElement | null;
    this.canvas = found;
    if (found) this.onCanvasResolved(found);
    return found;
  }

  getCamera(): ProjectorCamera | null {
    return getGlobalRenderer()?.getCamera() ?? null;
  }

  getCanvasSize(): CanvasSize | null {
    const canvas = this.resolveCanvas();
    if (!canvas) return null;
    return { width: canvas.clientWidth, height: canvas.clientHeight };
  }

  /**
   * While the renderer or canvas isn't resolved yet (mounted before the
   * WebGPU context exists), this reports dirty unconditionally so the
   * projector's own tick loop keeps retrying once a frame — a second
   * bootstrap poller would duplicate the "one loop" this kernel exists to
   * provide.
   */
  isDirty(): boolean {
    const renderer = getGlobalRenderer();
    const canvas = this.resolveCanvas();
    if (!renderer || !canvas) return true;

    const camera = renderer.getCamera();
    const snapshot: CameraSnapshot = {
      position: camera.getPosition(),
      rotation: camera.getRotation(),
      distance: camera.getDistance(),
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    };
    const last = this.lastSnapshot;
    this.lastSnapshot = snapshot;
    if (!last) return true;
    return (
      last.position.x !== snapshot.position.x ||
      last.position.y !== snapshot.position.y ||
      last.position.z !== snapshot.position.z ||
      last.rotation.azimuth !== snapshot.rotation.azimuth ||
      last.rotation.elevation !== snapshot.rotation.elevation ||
      last.distance !== snapshot.distance ||
      last.width !== snapshot.width ||
      last.height !== snapshot.height
    );
  }
}
