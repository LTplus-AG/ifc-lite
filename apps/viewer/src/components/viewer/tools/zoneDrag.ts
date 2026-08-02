/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure drag math for `ZoneOverlay`'s move/resize/rotate handles, extracted so
 * it's unit-testable without pointer events or a renderer (same pattern as
 * `useGanttBarDrag`'s `snapDeltaMs`/`pxPerMs`). The overlay probes "screen
 * pixels per +1 world metre along the handle's direction" at drag start;
 * everything here is closed-form arithmetic on that probe.
 *
 * Move handles are displayed along the zone's LOCAL axes (rotated by
 * `rotationY`), so the scalar delta must be applied along the SAME probed
 * world-space direction — writing it into a single world center component
 * made rotated zones diverge from the cursor (PR #1869 review, P1).
 */

import type { Zone } from '@/lib/zones';

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

export type DragKind =
  | { kind: 'move' }
  | { kind: 'resize'; axis: 'x' | 'y' | 'z' }
  | { kind: 'rotate' };

export interface DragState {
  op: DragKind;
  setId: string;
  zoneId: string;
  cursorStart: Vec2;
  /** Screen-space (dx, dy) for a +1 world-unit probe along `probeDir`,
   *  captured at drag start. */
  screenPerUnit: Vec2;
  /** Unit world-space direction the probe measured along. Move ops apply the
   *  scalar delta along this exact direction (local axis for X/Z handles,
   *  world Y for the vertical handle). */
  probeDir: Vec3;
  /** Zone snapshot at drag start (so deltas apply against a fixed base,
   *  not the previous frame's already-mutated zone). */
  startCenter: [number, number, number];
  startSize: [number, number, number];
  startRotationY: number;
}

/** Minimum zone half-extent (metres) a resize drag can shrink to. */
export const MIN_RESIZE_HALF_M = 0.05;

/**
 * Convert a cursor movement since drag start into a zone patch, or `null`
 * when the drag is degenerate (probe collapsed to <1px per metre).
 *
 * Every op's `screenPerUnit` was probed against a UNIT world-space direction
 * (a translation axis, a resize axis, or — for rotate — the handle's tangent
 * direction), so a single dot-product decomposition gives "how many world
 * metres along that unit direction does the cursor delta correspond to"
 * regardless of which op is active.
 */
export function computeZoneDragPatch(
  drag: DragState,
  cursor: Vec2,
): Partial<Omit<Zone, 'id'>> | null {
  const cursorDelta: Vec2 = { x: cursor.x - drag.cursorStart.x, y: cursor.y - drag.cursorStart.y };
  const ax = drag.screenPerUnit;
  const denom = ax.x * ax.x + ax.y * ax.y;
  if (denom < 1e-6) return null;
  const metres = (cursorDelta.x * ax.x + cursorDelta.y * ax.y) / denom;

  if (drag.op.kind === 'rotate') {
    // Tangential arc-length (metres) at the handle's radius converts to an
    // angle via the standard arc-length formula theta = s / r. Screen-space
    // rotation isn't a perfect proxy for a world Y-axis rotation under an
    // oblique camera, but it's exact in top/near-top view and a reasonable
    // approximation otherwise (documented v1 limitation).
    const radius = drag.startSize[0] / 2 + 1.2;
    if (radius < 1e-3) return null;
    return { rotationY: drag.startRotationY + metres / radius };
  }

  if (drag.op.kind === 'move') {
    // Apply the delta along the probed world-space direction itself, NOT a
    // single world component: the X/Z handles point along the zone's local
    // (rotated) axes, so at e.g. 90° rotation the local-X handle must move
    // the box along world Z.
    return {
      center: [
        drag.startCenter[0] + metres * drag.probeDir.x,
        drag.startCenter[1] + metres * drag.probeDir.y,
        drag.startCenter[2] + metres * drag.probeDir.z,
      ],
    };
  }

  // resize: symmetric about center along the given LOCAL axis (the probe ran
  // along the same local axis, so `metres` is already a local-frame length).
  const idx = drag.op.axis === 'x' ? 0 : drag.op.axis === 'y' ? 1 : 2;
  const nextHalf = Math.max(MIN_RESIZE_HALF_M, drag.startSize[idx] / 2 + metres);
  const size: [number, number, number] = [...drag.startSize];
  size[idx] = nextHalf * 2;
  return { size };
}
