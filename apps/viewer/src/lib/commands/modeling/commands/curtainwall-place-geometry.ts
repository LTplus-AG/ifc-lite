/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `curtainwall.place`'s gesture and the rules that turn it into builder
 * parameters and a ghost (charter #6232, D3). Its own module so the command's
 * HUD layers can read it without importing the command (which imports them).
 *
 * The gesture is a two-point path (Start, End) on the workplane plus the
 * curtain wall's dimensions. Panel width and height are TARGETS: the wall is
 * divided into the fewest equal bays and rows no wider than they are, exactly
 * as `curtainWallLayout` divides a bay count, so the ghost IS the layout the
 * builder writes.
 */

import { curtainWallLayout, type CurtainWallInStoreParams, type CurtainWallLayout } from '@ifc-lite/create';
import type { MeshData } from '@ifc-lite/geometry';
import type { Vec2 } from '@/lib/snap/types';
import { centredRectOutline, mergeGhostMeshes, prismGhostMesh } from '../ghost-shapes.js';
import type { Workplane } from '../types.js';
import { anchorOf, currentAngle, currentLength, endPoint, type WallPlaceGesture } from './wall-place-geometry.js';

export const MIN_CURTAIN_WALL_LENGTH = 0.3;
/** More panels than this is a typo, and a ghost the GPU should not be asked to draw. */
export const MAX_CURTAIN_WALL_PANELS = 1500;
export const CURTAIN_PANEL_THICKNESS = 0.024;

/** The wall path is the wall tool's: a chain of at most one placed point, typed length and angle. */
export interface CurtainWallGesture extends WallPlaceGesture {
  /** Metres. Kept from one curtain wall to the next. */
  height: number;
  /** Metres above the workplane to the bottom of the wall. */
  baseOffset: number;
  /** Target bay width along the wall, metres. */
  panelWidth: number;
  /** Target row height up the wall, metres. */
  panelHeight: number;
  /** Mullion and transom section, metres: across the wall face and through it. */
  mullionWidth: number;
  mullionDepth: number;
}

type Dimensions = Pick<CurtainWallGesture, 'height' | 'baseOffset' | 'panelWidth' | 'panelHeight' | 'mullionWidth' | 'mullionDepth'>;

const FACTORY_DIMENSIONS: Dimensions = { height: 3, baseOffset: 0, panelWidth: 1.5, panelHeight: 1.5, mullionWidth: 0.05, mullionDepth: 0.15 };

/**
 * The dimensions the user last typed. They outlive a gesture (Escape starts
 * the path over, a commit starts the next wall) but not the page, like the
 * other tools' defaults; `resetCurtainWallDimensions` is for tests.
 */
let kept: Dimensions = FACTORY_DIMENSIONS;

export function resetCurtainWallDimensions(): void {
  kept = FACTORY_DIMENSIONS;
}

/** `g` with `patch` applied; the new dimensions are what the next gesture starts with. */
export function withDimensions(g: CurtainWallGesture, patch: Partial<Dimensions>): CurtainWallGesture {
  const next = { ...g, ...patch };
  const { height, baseOffset, panelWidth, panelHeight, mullionWidth, mullionDepth } = next;
  kept = { height, baseOffset, panelWidth, panelHeight, mullionWidth, mullionDepth };
  return next;
}

export const initCurtainWall = (): CurtainWallGesture => ({ chain: [], cursor: null, length: null, angle: null, ...kept });

export { anchorOf, currentAngle, currentLength, endPoint };

/** Equal bays no wider than `target` over `extent`. */
export function divisions(extent: number, target: number): number {
  return Math.max(1, Math.ceil(extent / target - 1e-9));
}

export type CurtainWallPlan =
  | { ok: true; params: CurtainWallInStoreParams; start: Vec2; end: Vec2; bays: number; rows: number }
  | { ok: false; reason: 'noPath' | 'tooShort' | 'tooManyPanels' };

/** The builder parameters for the gesture, at storey-local elevation `z` (the workplane's). */
export function planCurtainWall(g: CurtainWallGesture, z: number): CurtainWallPlan {
  const start = anchorOf(g);
  const end = endPoint(g);
  if (!start || !end) return { ok: false, reason: 'noPath' };
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (length < MIN_CURTAIN_WALL_LENGTH) return { ok: false, reason: 'tooShort' };
  const bays = divisions(length, g.panelWidth);
  const rows = divisions(g.height, g.panelHeight);
  if (bays * rows > MAX_CURTAIN_WALL_PANELS) return { ok: false, reason: 'tooManyPanels' };
  const base = z + g.baseOffset;
  return {
    ok: true,
    start,
    end,
    bays,
    rows,
    params: {
      Start: [start[0], start[1], base],
      End: [end[0], end[1], base],
      Height: g.height,
      UGrid: bays,
      VGrid: rows,
      MullionProfile: { Type: 'Rectangle', XDim: g.mullionWidth, YDim: g.mullionDepth },
      PanelThickness: CURTAIN_PANEL_THICKNESS,
    },
  };
}

/** The layout the builder would write, or null when the members leave no clear opening. */
export function layoutOf(plan: Extract<CurtainWallPlan, { ok: true }>): CurtainWallLayout | null {
  try {
    return curtainWallLayout(plan.params);
  } catch (error) {
    console.debug('[curtainwall.place] no layout for this gesture', error);
    return null;
  }
}

const FRAME_COLOR: [number, number, number, number] = [0.25, 0.6, 1, 0.6];
const PANEL_COLOR: [number, number, number, number] = [0.55, 0.85, 1, 0.28];

/**
 * The layout as two ghost meshes on the workplane: the frame (mullions,
 * transoms) and the panels. Each part is a prism over its plan rectangle, put
 * where `addCurtainWallToStore` puts it: centred on the path line, mullions
 * full height, transoms between the mullion faces, panels in the clear openings.
 */
export function curtainWallGhosts(
  plane: Workplane,
  plan: Extract<CurtainWallPlan, { ok: true }>,
  layout: CurtainWallLayout,
  g: CurtainWallGesture,
  ids: readonly [number, number],
): MeshData[] {
  const { start, end } = plan;
  const dx = (end[0] - start[0]) / layout.length, dy = (end[1] - start[1]) / layout.length;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const at = (u: number): Vec2 => [start[0] + dx * u, start[1] + dy * u];
  const base = g.baseOffset;
  const prism = (u0: number, u1: number, thickness: number, z0: number, z1: number) => prismGhostMesh(
    plane, centredRectOutline(at((u0 + u1) / 2), u1 - u0, thickness, deg), z0, z1, ids[0],
  );
  const w = g.mullionWidth;
  const frame = [
    ...layout.mullions.map((u) => prism(u - w / 2, u + w / 2, g.mullionDepth, base, base + layout.height)),
    ...layout.transoms.map((t) => prism(t.u0, t.u1, g.mullionDepth, base + t.v - w / 2, base + t.v + w / 2)),
  ].filter((m): m is MeshData => m !== null);
  const panels = layout.panels
    .map((p) => prism(p.u0, p.u1, CURTAIN_PANEL_THICKNESS, base + p.v0, base + p.v1))
    .filter((m): m is MeshData => m !== null);
  return [mergeGhostMeshes(frame, ids[0], FRAME_COLOR), mergeGhostMeshes(panels, ids[1], PANEL_COLOR)]
    .filter((m): m is MeshData => m !== null);
}
