/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The surface under the pointer for navigation where the CPU raycast is
 * gated off (#8769): large models, outlier models with a robust orbit anchor,
 * and streaming (`zoomSurface.ts`, `orbitPivotCensus.ts`).
 *
 * Without it a wheel zoom on such a model is a plain dolly that flies through
 * the ground, and an orbit pivots on the scene centre far from what the user
 * is looking at. `Renderer.probeSurface` reads the last frame's depth at a
 * point instead: it costs one texel whatever the model size, but resolves a
 * frame later. So the answer is cached here and the gestures read it
 * synchronously, asking for a fresh probe as they go:
 *
 * - the mouse probes the hover position, so the first wheel notch or orbit
 *   press usually finds an answer waiting;
 * - each surface step probes again, so the point sharpens as the camera nears
 *   (depth precision falls with distance);
 * - a press that found nothing adopts the probe when it lands, if the camera
 *   has not moved since.
 *
 * A cached point is a world position, valid on any camera pose, so the check
 * is geometric: it must still project under the queried pixel. Requests are
 * coalesced to one readback in flight, issued on the next animation frame so
 * the probe reads the frame that the latest camera move produced.
 */

import type { SurfacePoint } from './zoomSurface.js';

/** How far (CSS px) the cached point may project from the queried pixel. */
export const SURFACE_PROBE_SLOP_PX = 4;
/**
 * How old a cached point may be. The scene can change under a still camera
 * (an element hidden, streamed in), so a stale point is dropped; every read
 * also requests a fresh one, so a stale answer lasts at most one step.
 */
export const SURFACE_PROBE_MAX_AGE_MS = 2000;

export interface SurfaceProbeRenderer {
  probeSurface?(x: number, y: number): Promise<SurfacePoint | null>;
  getCanvas?(): Pick<HTMLCanvasElement, 'getBoundingClientRect'>;
}
export interface SurfaceProbeCamera {
  projectToScreen?(point: SurfacePoint, width: number, height: number): { x: number; y: number } | null;
}

export interface SurfaceProbe {
  /**
   * Probe the canvas point (CSS px) on the next frame. Resolves with that
   * probe's point (null for empty space or when superseded by nothing usable).
   */
  request(x: number, y: number, scene?: string): Promise<SurfacePoint | null>;
  /**
   * The cached surface point under the canvas point, or null. Never blocks.
   * `scene` keys what was visible (hidden/isolated sets): a point probed under
   * another key may sit on an element since hidden, so it is not reused.
   */
  peek(x: number, y: number, scene?: string): SurfacePoint | null;
}

const probes = new WeakMap<object, SurfaceProbe>();

/** The probe shared by every gesture on this renderer, or null when it has no depth probe. */
export function surfaceProbeFor(renderer: SurfaceProbeRenderer, camera: SurfaceProbeCamera): SurfaceProbe | null {
  const probeSurface = renderer.probeSurface?.bind(renderer);
  const getCanvas = renderer.getCanvas?.bind(renderer);
  const project = camera.projectToScreen?.bind(camera);
  if (!probeSurface || !getCanvas || !project) return null;
  let probe = probes.get(renderer);
  if (!probe) {
    probe = createSurfaceProbe(probeSurface, getCanvas, project);
    probes.set(renderer, probe);
  }
  return probe;
}

type Waiter = (point: SurfacePoint | null) => void;

export function createSurfaceProbe(
  probeSurface: (x: number, y: number) => Promise<SurfacePoint | null>,
  getCanvas: () => Pick<HTMLCanvasElement, 'getBoundingClientRect'>,
  project: (point: SurfacePoint, width: number, height: number) => { x: number; y: number } | null,
  schedule: (run: () => void) => void = (run) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  },
): SurfaceProbe {
  let latest: { point: SurfacePoint; at: number; scene: string } | null = null;
  let pending: { x: number; y: number; scene: string; waiters: Waiter[] } | null = null;
  let busy = false; // scheduled or in flight

  const run = () => {
    const job = pending;
    pending = null;
    if (!job) { busy = false; return; }
    const settle = (point: SurfacePoint | null) => {
      // A miss clears the cache: the pixel the gestures will ask about is empty now.
      latest = point ? { point, at: Date.now(), scene: job.scene } : null;
      for (const w of job.waiters) w(point);
      if (pending) schedule(run); else busy = false;
    };
    probeSurface(job.x, job.y).then(settle, (err: unknown) => {
      console.warn('[Viewport] Surface depth probe failed:', err);
      settle(null);
    });
  };

  return {
    request(x, y, scene = '') {
      return new Promise((resolve) => {
        // The newest position wins; earlier callers hear its answer.
        pending = { x, y, scene, waiters: [...(pending?.waiters ?? []), resolve] };
        if (!busy) { busy = true; schedule(run); }
      });
    },
    peek(x, y, scene = '') {
      if (!latest || latest.scene !== scene || Date.now() - latest.at >= SURFACE_PROBE_MAX_AGE_MS) return null;
      const { width, height } = getCanvas().getBoundingClientRect();
      if (!(width > 0 && height > 0)) return null;
      const screen = project(latest.point, width, height);
      if (!screen || Math.abs(screen.x - x) > SURFACE_PROBE_SLOP_PX || Math.abs(screen.y - y) > SURFACE_PROBE_SLOP_PX) return null;
      return latest.point;
    },
  };
}
