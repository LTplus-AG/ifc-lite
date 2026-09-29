/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Previews of copies (#6232 C3): the elements' own meshes, turned and moved
 * the way the commit will place them. A mesh is taken to its storey's
 * workplane, moved there (storey-local metres, the frame the copy is written
 * in) and mapped back through the target storey's workplane, so the preview
 * sits where the copy lands, on another storey too.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { CopyTransform } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { meshesForOwningModel } from '@/store/owningModelMeshes';
import { commandGhostId } from './ghost.js';
import type { Vec3, Workplane } from './types.js';

const GHOST_COLOR: [number, number, number, number] = [0.25, 0.6, 1, 0.45];
/** Past this many copies the preview shows the first ones only; the commit writes them all. */
export const MAX_GHOSTED_COPIES = 64;

type Affine = { o: Vec3; x: Vec3; y: Vec3; z: Vec3 };

/** Storey-local: the turn about the vertical through `pivot`, then the move. */
export function applyCopyTransform(t: CopyTransform, p: Vec3): Vec3 {
  const turn = t.turn ?? 0;
  const [px, py] = t.pivot ?? [0, 0];
  const [ox, oy, oz] = t.offset ?? [0, 0, 0];
  const c = Math.cos(turn), s = Math.sin(turn);
  const dx = p[0] - px, dy = p[1] - py;
  return [px + c * dx - s * dy + ox, py + s * dx + c * dy + oy, p[2] + oz];
}

/** render → source storey-local → moved → target storey-local → render, as one affine map. */
function renderMap(from: Workplane, to: Workplane, t: CopyTransform): Affine {
  const map = (p: Vec3) => to.localToRender(applyCopyTransform(t, from.renderToLocal(p)));
  const o = map([0, 0, 0]);
  const axis = (p: Vec3): Vec3 => { const q = map(p); return [q[0] - o[0], q[1] - o[1], q[2] - o[2]]; };
  return { o, x: axis([1, 0, 0]), y: axis([0, 1, 0]), z: axis([0, 0, 1]) };
}

/**
 * `mesh` under `m`. A mesh in a local frame (`origin` + `positions`, #6391)
 * keeps one: its origin goes through the whole map, its positions through the
 * linear part only, so building-scale coordinates keep their f32 precision.
 */
function transformed(mesh: MeshData, m: Affine, expressId: number): MeshData {
  const linear = (x: number, y: number, z: number, out: Float32Array | number[], i: number) => {
    for (let k = 0; k < 3; k++) out[i + k] = m.x[k] * x + m.y[k] * y + m.z[k] * z;
  };
  const [ox, oy, oz] = mesh.origin ?? [0, 0, 0];
  const origin = [0, 0, 0];
  linear(ox, oy, oz, origin, 0);
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) linear(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2], positions, i);
  const normals = new Float32Array(mesh.normals.length);
  for (let i = 0; i < mesh.normals.length; i += 3) {
    linear(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2], normals, i);
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    for (let k = 0; k < 3; k++) normals[i + k] /= length;
  }
  return {
    expressId, positions, normals, indices: mesh.indices, color: [...GHOST_COLOR],
    origin: [origin[0] + m.o[0], origin[1] + m.o[1], origin[2] + m.o[2]],
  };
}

/** Meshes by entity, per mesh list: a preview reads the same few elements on every pointer move. */
const byEntity = new WeakMap<readonly MeshData[], Map<number, MeshData[]>>();

/** The live meshes of `expressIds` (model-local) of `modelId`. */
export function sourceMeshes(s: ViewerState, modelId: string, expressIds: readonly number[]): MeshData[] {
  const all = meshesForOwningModel(s, modelId) ?? [];
  let index = byEntity.get(all);
  if (!index) {
    index = new Map();
    for (const mesh of all) {
      const list = index.get(mesh.expressId);
      if (list) list.push(mesh);
      else index.set(mesh.expressId, [mesh]);
    }
    byEntity.set(all, index);
  }
  return expressIds.flatMap((id) => index.get(toGlobalIdFromModels(s.models, modelId, id)) ?? []);
}

/** One ghost of `meshes` per transform (the first {@link MAX_GHOSTED_COPIES}). */
export function copyGhosts(s: ViewerState, meshes: readonly MeshData[], from: Workplane, to: Workplane, transforms: readonly CopyTransform[]): MeshData[] {
  if (meshes.length === 0) return [];
  const id = commandGhostId(s);
  return transforms.slice(0, MAX_GHOSTED_COPIES).flatMap((t) => {
    const m = renderMap(from, to, t);
    return meshes.map((mesh) => transformed(mesh, m, id));
  });
}
