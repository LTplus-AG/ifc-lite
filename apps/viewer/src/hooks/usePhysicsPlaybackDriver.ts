/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drives the physics-simulation playback loop:
 * - Snapshots the affected meshes' GPU vertex slices when a trajectory
 *   becomes available.
 * - Each animation frame, advances `physicsPlayback.frame` based on the
 *   trajectory's frame rate and the user's speed multiplier, then patches
 *   the renderer with that frame's per-body translation + rotation.
 * - Clears the snapshot when playback ends or the result is reset.
 *
 * The hook expects to be mounted once at viewport scope; the Viewport
 * component already handles renderer ref plumbing via `getGlobalRenderer`.
 */

import { useEffect, useRef } from 'react';
import type { AnimTransform } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from '@/hooks/useBCF';

const FLOATS_PER_POSE = 7;

export function usePhysicsPlaybackDriver(): void {
  const result = useViewerStore((s) => s.physicsResult);
  const playback = useViewerStore((s) => s.physicsPlayback);
  const setPlayback = useViewerStore((s) => s.setPhysicsPlayback);
  const removed = useViewerStore((s) => s.physicsRemoved);

  // Used to avoid re-snapshotting the same trajectory repeatedly.
  const activeTrajectoryRef = useRef<Float32Array | null>(null);
  const lastFrameAppliedRef = useRef<number>(-1);

  // ─── Snapshot lifecycle ────────────────────────────────────────────
  useEffect(() => {
    const renderer = getGlobalRenderer();
    if (!renderer) return;
    const traj = result?.trajectory;
    const newPoses = traj?.poses ?? null;

    if (newPoses === activeTrajectoryRef.current) return;

    // Tear down the previous animation session before replacing it.
    if (activeTrajectoryRef.current) {
      try {
        renderer.endPhysicsAnimation();
      } catch (err) {
        console.error('[Physics] endPhysicsAnimation failed:', err);
      }
    }

    if (newPoses && traj && removed) {
      // Animate every body in the trajectory EXCEPT the removed one — that
      // mesh stays in its baked position visually, but the user already
      // sees it disappear via colorize / hide once we add that step.
      try {
        renderer.beginPhysicsAnimation(traj.bodyOrder);
      } catch (err) {
        console.error('[Physics] beginPhysicsAnimation failed:', err);
      }
    }

    activeTrajectoryRef.current = newPoses;
    lastFrameAppliedRef.current = -1;

    return () => {
      // On unmount (or before the next snapshot effect runs), restore the
      // baked vertex positions so we don't leave the renderer in a
      // half-transformed state.
      if (!activeTrajectoryRef.current) return;
      const r = getGlobalRenderer();
      if (!r) return;
      try {
        r.endPhysicsAnimation();
      } catch (err) {
        console.error('[Physics] endPhysicsAnimation failed during cleanup:', err);
      } finally {
        activeTrajectoryRef.current = null;
        lastFrameAppliedRef.current = -1;
      }
    };
  }, [result, removed]);

  // ─── Per-frame application (RAF + slider scrubbing) ────────────────
  useEffect(() => {
    const renderer = getGlobalRenderer();
    if (!renderer) return;
    const traj = result?.trajectory;
    if (!traj || !activeTrajectoryRef.current) return;

    const frameCount = traj.frameCount;
    if (frameCount === 0) return;
    const bodyCount = traj.bodyOrder.length;
    if (bodyCount === 0) return;

    let cancelled = false;
    let lastWallClock = performance.now();
    let accumulated = 0;

    const apply = (frame: number) => {
      if (frame === lastFrameAppliedRef.current) return;
      lastFrameAppliedRef.current = frame;
      const transforms = framePoses(traj.poses, frame, traj.bodyOrder);
      try {
        renderer.applyPhysicsAnimationFrame(transforms);
      } catch (err) {
        console.error('[Physics] applyPhysicsAnimationFrame failed:', err);
      }
    };

    // Clamp incoming frame to the new trajectory's range. Without this, a
    // re-run with fewer frames would index past `poses` and feed garbage
    // transforms into the renderer.
    const startFrame = Math.max(0, Math.min(frameCount - 1, playback.frame));
    if (startFrame !== playback.frame) {
      setPlayback({ frame: startFrame });
    }
    apply(startFrame);

    if (!playback.isPlaying) return;

    const tick = (now: number) => {
      if (cancelled) return;
      const dt = (now - lastWallClock) / 1000;
      lastWallClock = now;
      accumulated += dt * playback.speed;
      const advance = Math.floor(accumulated / traj.frameDt);
      if (advance > 0) {
        accumulated -= advance * traj.frameDt;
        let next = startFrame + advance;
        if (next >= frameCount) {
          if (playback.loop) {
            next = next % frameCount;
          } else {
            next = frameCount - 1;
            setPlayback({ frame: next, isPlaying: false });
            apply(next);
            return;
          }
        }
        setPlayback({ frame: next });
        apply(next);
      }
      raf = requestAnimationFrame(tick);
    };

    let raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [playback, result, setPlayback]);
}

function framePoses(
  poses: Float32Array,
  frame: number,
  bodyOrder: number[],
): Map<number, AnimTransform> {
  const out = new Map<number, AnimTransform>();
  const bodyCount = bodyOrder.length;
  const base = frame * bodyCount * FLOATS_PER_POSE;
  for (let b = 0; b < bodyCount; b++) {
    const o = base + b * FLOATS_PER_POSE;
    out.set(bodyOrder[b], {
      tx: poses[o],
      ty: poses[o + 1],
      tz: poses[o + 2],
      qx: poses[o + 3],
      qy: poses[o + 4],
      qz: poses[o + 5],
      qw: poses[o + 6],
    });
  }
  return out;
}
