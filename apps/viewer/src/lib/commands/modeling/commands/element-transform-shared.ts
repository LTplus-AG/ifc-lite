/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What `element.move` and `element.rotate` share (charter #6232, C2): the
 * selection they act on, its centre, and the preview — the selection's own
 * meshes (and the fillings that move with it), moved or turned, on the
 * `command` ghost channel. Its own module so the HUD layers can read it
 * without importing the commands.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { modelPointToWorkspacePoint } from '@/lib/model-placement/rotation';
import { fromRenderTranslation, toRenderTranslation } from '@/lib/model-placement/translation';
import { planSelectionTransform, type ElementTransformOp } from '@/lib/element-transform/commit';
import type { Vec2 } from '@/lib/snap/types';
import type { Vec3, Workplane } from '../types.js';

/** The elements a move or turn acts on: the selection, in one model. */
export interface TransformSelection {
  readonly modelId: string;
  /** Model-local express ids, the primary selection last. */
  readonly ids: readonly number[];
  /** Global ids of everything that moves (selection + hosted), for the preview. */
  readonly movedGlobalIds: readonly number[];
  /** Why it cannot move (null: it can). */
  readonly refusal: string | null;
}

/**
 * The selection as a move or turn sees it. From the selected ids, not
 * `selectedEntity` (synced by a hook after render). Elements of other
 * federated models than the primary one's are left out: one commit writes
 * one model's history.
 */
export function readTransformSelection(s: ViewerState): TransformSelection | null {
  const primary = s.selectedEntityId;
  if (primary === null) return null;
  const globalIds = s.selectedEntityIds.has(primary) ? [...s.selectedEntityIds].filter((id) => id !== primary).concat(primary) : [primary];
  const { modelId } = resolveEntityRef(primary);
  if (!s.models.get(modelId)?.ifcDataStore) return null;
  const ids = globalIds.map(resolveEntityRef).filter((r) => r.modelId === modelId).map((r) => r.expressId);
  const plan = planSelectionTransform(s, modelId, ids);
  if (!plan) return null;
  const moved = [...plan.roots.map((r) => r.expressId), ...plan.carried];
  const refusal = plan.refused.length > 0 ? `#${plan.refused[0].expressId}` : null;
  return { modelId, ids, movedGlobalIds: moved.map((id) => toGlobalIdFromModels(s.models, modelId, id)), refusal };
}

/**
 * Model-frame mesh vertex → render point: the mesh's own origin (a per-element
 * local frame, absent = absolute), then the model's reposition placement.
 */
function toRenderFor(s: ViewerState, modelId: string): (mesh: MeshData, x: number, y: number, z: number) => Vec3 {
  const placement = { translation: displayedTranslation(s.modelPlacement, modelId), rotation: placementFor(s.modelPlacement, modelId).rotation };
  return (mesh, x, y, z) => {
    const o = mesh.origin;
    const point = o ? { x: x + o[0], y: y + o[1], z: z + o[2] } : { x, y, z };
    return toRenderTranslation(modelPointToWorkspacePoint(fromRenderTranslation(point), placement));
  };
}

function meshesOf(s: ViewerState, selection: TransformSelection): MeshData[] {
  const ids = new Set(selection.movedGlobalIds);
  const meshes = (s.models.get(selection.modelId)?.geometryResult ?? s.geometryResult)?.meshes ?? [];
  return meshes.filter((m) => ids.has(m.expressId));
}

/** The render-space centre of the selection's bounding box (null without meshes). */
export function selectionRenderCentre(s: ViewerState, selection: TransformSelection): Vec3 | null {
  const toRender = toRenderFor(s, selection.modelId);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of meshesOf(s, selection)) {
    const p = mesh.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const r = toRender(mesh, p[i], p[i + 1], p[i + 2]);
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], r[k]); max[k] = Math.max(max[k], r[k]); }
    }
  }
  return Number.isFinite(min[0]) ? [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] : null;
}

/**
 * The selection's plan extent on `plane`: its bounding-box centre and the
 * radius of the circle round it (local metres). Null without meshes.
 */
export function selectionExtent(s: ViewerState, selection: TransformSelection, plane: Workplane): { centre: Vec2; radius: number } | null {
  const toRender = toRenderFor(s, selection.modelId);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const mesh of meshesOf(s, selection)) {
    const p = mesh.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const l = plane.renderToLocal(toRender(mesh, p[i], p[i + 1], p[i + 2]));
      minX = Math.min(minX, l[0]); maxX = Math.max(maxX, l[0]);
      minY = Math.min(minY, l[1]); maxY = Math.max(maxY, l[1]);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { centre: [(minX + maxX) / 2, (minY + maxY) / 2], radius: Math.hypot(maxX - minX, maxY - minY) / 2 };
}

/** The render-space map `op` applies; `up` is the workplane normal a turn is about. */
export function renderTransform(op: ElementTransformOp, up: Vec3): (p: Vec3) => Vec3 {
  if (op.kind === 'move') {
    const d: Vec3 = [op.to[0] - op.from[0], op.to[1] - op.from[1], op.to[2] - op.from[2]];
    return (p) => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
  }
  // Rodrigues about `up` through the pivot; `up` is a unit vector.
  const c = Math.cos(op.angle), s = Math.sin(op.angle);
  const [kx, ky, kz] = up;
  const [ox, oy, oz] = op.pivot;
  return ([px, py, pz]) => {
    const vx = px - ox, vy = py - oy, vz = pz - oz;
    const dot = kx * vx + ky * vy + kz * vz;
    const cx = ky * vz - kz * vy, cy = kz * vx - kx * vz, cz = kx * vy - ky * vx;
    return [
      ox + vx * c + cx * s + kx * dot * (1 - c),
      oy + vy * c + cy * s + ky * dot * (1 - c),
      oz + vz * c + cz * s + kz * dot * (1 - c),
    ];
  };
}

const GHOST_COLOR: [number, number, number, number] = [0.25, 0.6, 1, 0.45];
/** Past this many vertices the preview stops adding meshes: it is a hint, not a copy of the model. */
const GHOST_VERTEX_BUDGET = 300_000;

/** The selection's meshes with `op` applied, in render space, as ghosts under `ghostId`. */
export function transformedGhosts(s: ViewerState, selection: TransformSelection, op: ElementTransformOp, up: Vec3, ghostId: number): MeshData[] {
  const toRender = toRenderFor(s, selection.modelId);
  const apply = renderTransform(op, up);
  const out: MeshData[] = [];
  let budget = GHOST_VERTEX_BUDGET;
  for (const mesh of meshesOf(s, selection)) {
    const count = mesh.positions.length / 3;
    if (count > budget) break;
    budget -= count;
    const positions = new Float32Array(mesh.positions.length);
    const normals = new Float32Array(mesh.normals.length);
    const p = mesh.positions, n = mesh.normals;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const base = toRender(mesh, p[i], p[i + 1], p[i + 2]);
      const moved = apply(base);
      positions.set(moved, i);
      if (i + 2 < n.length) {
        const tip = apply(toRender(mesh, p[i] + n[i], p[i + 1] + n[i + 1], p[i + 2] + n[i + 2]));
        normals.set([tip[0] - moved[0], tip[1] - moved[1], tip[2] - moved[2]], i);
      }
    }
    out.push({ expressId: ghostId, positions, normals, indices: mesh.indices, color: GHOST_COLOR });
  }
  return out;
}
