/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The boxes `element.align` lines up (charter #6232, C4): each element's
 * footprint in the session workplane, read off its rendered meshes (so an
 * imported element aligns like an authored one), and the shift that brings one
 * box's chosen edge onto another's.
 *
 * Edges are the workplane's own axes, as the plan draws them: Left / Centre /
 * Right along its u axis, Top / Middle / Bottom along v (up the plan).
 */

import type { MeshData } from '@ifc-lite/geometry';
import { effectiveSpatialMembers } from '@/lib/effective-spatial-members';
import { toGlobalIdFromModels } from '@/store/globalId';
import { meshesForOwningModel, type OwningModelMeshSource } from '@/store/owningModelMeshes';
import type { ViewerState } from '@/store';
import type { Vec2 } from '@/lib/snap/types';
import type { Workplane } from './types.js';

export type AlignMode = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

export const ALIGN_MODES: readonly AlignMode[] = ['left', 'centre', 'right', 'top', 'middle', 'bottom'];

/** An element's extent in workplane-local metres: plan box and height range. */
export interface PlanBox {
  readonly min: Vec2;
  readonly max: Vec2;
  readonly z0: number;
  readonly z1: number;
}

/** True for the modes that move along u (the rest move along v). */
export const alignsAlongU = (mode: AlignMode): boolean => mode === 'left' || mode === 'centre' || mode === 'right';

const MAX_COORD = 1e7;

/** `expressId`'s meshes' extent in `plane`, or null when it has no rendered geometry. */
export function planBoxOf(meshes: readonly MeshData[], globalId: number, plane: Workplane): PlanBox | null {
  let u0 = Infinity, v0 = Infinity, z0 = Infinity, u1 = -Infinity, v1 = -Infinity, z1 = -Infinity;
  for (const mesh of meshes) {
    if (mesh.expressId !== globalId) continue;
    const [ox, oy, oz] = mesh.origin ?? [0, 0, 0];
    const p = mesh.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const x = p[i] + ox, y = p[i + 1] + oy, z = p[i + 2] + oz;
      if (!(Math.abs(x) < MAX_COORD && Math.abs(y) < MAX_COORD && Math.abs(z) < MAX_COORD)) continue;
      const [u, v, h] = plane.renderToLocal([x, y, z]);
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
      if (h < z0) z0 = h; if (h > z1) z1 = h;
    }
  }
  return Number.isFinite(u0) ? { min: [u0, v0], max: [u1, v1], z0, z1 } : null;
}

/**
 * The meshes `modelId` renders: its own, or the top-level mirror only when it
 * IS the active model. Mesh ids are global ids (`idOffset + express id`), so
 * another model's meshes must never stand in (#4929, `owningModelMeshes.ts`).
 */
export function modelMeshes(s: OwningModelMeshSource, modelId: string): readonly MeshData[] {
  return meshesForOwningModel(s, modelId) ?? [];
}

/** Every element contained in `storeyId` that has geometry to line up, by express id. */
export function storeyBoxes(s: ViewerState, modelId: string, storeyId: number, plane: Workplane): Map<number, PlanBox> {
  const store = s.models.get(modelId)?.ifcDataStore;
  const boxes = new Map<number, PlanBox>();
  if (!store) return boxes;
  const meshes = modelMeshes(s, modelId);
  for (const expressId of effectiveSpatialMembers(store, s.mutationViews.get(modelId), storeyId)) {
    const box = planBoxOf(meshes, toGlobalIdFromModels(s.models, modelId, expressId), plane);
    if (box) boxes.set(expressId, box);
  }
  return boxes;
}

/** How far outside a box a click still picks it (metres): a wall's thin footprint is easy to miss. */
const PICK_REACH = 0.05;

/** The element whose box holds `point`: the smallest, so a column on a slab wins. Null when none does. */
export function pickBox(boxes: ReadonlyMap<number, PlanBox>, point: Vec2): number | null {
  let best: number | null = null;
  let bestArea = Infinity;
  for (const [id, box] of boxes) {
    if (point[0] < box.min[0] - PICK_REACH || point[0] > box.max[0] + PICK_REACH) continue;
    if (point[1] < box.min[1] - PICK_REACH || point[1] > box.max[1] + PICK_REACH) continue;
    const area = Math.max(box.max[0] - box.min[0], 0.01) * Math.max(box.max[1] - box.min[1], 0.01);
    if (area < bestArea) { best = id; bestArea = area; }
  }
  return best;
}

/** The edge (or centre line) of `box` that `mode` names, along its axis. */
export function edgeOf(mode: AlignMode, box: PlanBox): number {
  switch (mode) {
    case 'left': return box.min[0];
    case 'right': return box.max[0];
    case 'centre': return (box.min[0] + box.max[0]) / 2;
    case 'top': return box.max[1];
    case 'bottom': return box.min[1];
    case 'middle': return (box.min[1] + box.max[1]) / 2;
  }
}

/** The workplane-local shift that puts `box`'s `mode` edge on `reference`'s. */
export function alignShift(mode: AlignMode, reference: PlanBox, box: PlanBox): Vec2 {
  const d = edgeOf(mode, reference) - edgeOf(mode, box);
  return alignsAlongU(mode) ? [d, 0] : [0, d];
}

/** `box` moved by `shift`. */
export function shiftBox(box: PlanBox, shift: Vec2): PlanBox {
  return { ...box, min: [box.min[0] + shift[0], box.min[1] + shift[1]], max: [box.max[0] + shift[0], box.max[1] + shift[1]] };
}
