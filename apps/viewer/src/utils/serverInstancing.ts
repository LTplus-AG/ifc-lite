/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Server-processed shared shapes → GPU-instanced (IFNS) shards.
 *
 * The server sends a repeated shape's geometry once and places each occurrence
 * with an `origin` and a rotation (`world = origin + R * p`, Y-up metres, in
 * the server's shifted frame). The viewer used to copy that block into one
 * flat mesh per occurrence. This module writes the occurrences as instance
 * records instead, so a processed model reaches the renderer the way a local
 * parse does: each shape uploaded once, drawn with one instanced draw.
 *
 * FRAME. An IFNS shard is in the native IFC Z-up frame and the renderer
 * applies `SWAP` (Z-up → Y-up) to every instance matrix
 * (`composeInstanceMatrix` in `@ifc-lite/renderer`). The template keeps the
 * server's Y-up vertices unchanged, and each record's matrix is
 * `SWAP⁻¹ · [R | origin]`, so the renderer's `SWAP · M · p` is exactly
 * `origin + R * p`, the vertex the flat path draws. Normals go through the
 * same upper 3×3, which is `R` again once `SWAP` is applied.
 */

import { encodeInstancedShard, type EntityWorldAabb, type InstancedShardTemplateInput, type InstancedShardInstanceInput } from '@ifc-lite/geometry';
import type { MeshData as ServerMeshData, SharedShape, SharedShapeOccurrence } from '@ifc-lite/server-client';
import { OPAQUE_ALPHA_CUTOFF } from '@ifc-lite/renderer';
import { isClassToggledType } from '../store/typeVisibilityFilter.js';
import { MAX_VALID_COORD, type Bounds3D } from './localParsingUtils.js';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Row-major `SWAP⁻¹ · [R | o]`: rows (x, -z, y) of the Y-up placement. */
export function instanceTransform(occ: Pick<SharedShapeOccurrence, 'origin' | 'rotation'>): number[] {
  const r = occ.rotation ?? IDENTITY;
  const [ox, oy, oz] = occ.origin;
  return [
    r[0], r[1], r[2], ox,
    -r[6], -r[7], -r[8], -oz,
    r[3], r[4], r[5], oy,
    0, 0, 0, 1,
  ];
}

/**
 * Occurrences a shape needs, model-wide, before it is drawn instanced. The
 * local partition's gate (`INSTANCE_MIN_OCCURRENCES` in
 * `rust/wasm-bindings/src/api/gpu_meshes/batch_partition.rs`): below it one
 * instanced draw per shape costs more than the flat path's consolidated
 * batches save.
 */
export const INSTANCE_MIN_OCCURRENCES = 8;

/**
 * Whether an occurrence may ride an instance record, by the local partition's
 * rule (`is_instancing_candidate`): opaque, and not of a class a whole-class
 * toggle gates. The renderer skips instance records below the opaque cutoff
 * (`prepareInstancedRender`), and a record carries no class for the toggle to
 * see. The decoder already kept material-layer slices and type geometry flat.
 */
export function instanceCandidate(occ: SharedShapeOccurrence): boolean {
  return occ.color[3] >= OPAQUE_ALPHA_CUTOFF && !isClassToggledType(occ.ifc_type);
}

/**
 * One occurrence as the flat mesh the decoder would have produced for its row:
 * the block copied, rotated, and placed by `origin` (omitted at zero), with the
 * same arithmetic as `applyInstanceRotation`.
 */
export function occurrenceMesh(shape: SharedShape, occ: SharedShapeOccurrence): ServerMeshData {
  const positions = new Float32Array(shape.positions);
  const normals = new Float32Array(shape.normals);
  const r = occ.rotation;
  if (r) {
    for (const buf of [positions, normals]) {
      for (let v = 0; v < buf.length; v += 3) {
        const x = buf[v], y = buf[v + 1], z = buf[v + 2];
        buf[v] = r[0] * x + r[1] * y + r[2] * z;
        buf[v + 1] = r[3] * x + r[4] * y + r[5] * z;
        buf[v + 2] = r[6] * x + r[7] * y + r[8] * z;
      }
    }
  }
  return {
    express_id: occ.express_id,
    ifc_type: occ.ifc_type,
    positions,
    normals,
    indices: new Uint32Array(shape.indices),
    color: occ.color,
    ...(occ.origin.some((v) => v !== 0) ? { origin: occ.origin } : {}),
    ...(occ.geometry_item_id !== undefined ? { geometry_item_id: occ.geometry_item_id } : {}),
    ...(occ.metallic !== undefined ? { metallic: occ.metallic } : {}),
    ...(occ.roughness !== undefined ? { roughness: occ.roughness } : {}),
  };
}

/**
 * Decides, per shape and across a whole stream, which occurrences are drawn
 * instanced. A stream-wide shape is counted over every batch so far, so its
 * instanced occurrences start once {@link INSTANCE_MIN_OCCURRENCES} have
 * arrived; the ones before stay flat. A shape whose offsets are batch-local is
 * judged on its own batch.
 */
export class SharedShapeRouting {
  private readonly seen = new Map<string, number>();

  /** Split `shapes` into the shapes to instance (candidate occurrences only) and flat meshes for the rest. */
  split(shapes: readonly SharedShape[] | undefined): { instanced: SharedShape[]; flat: ServerMeshData[] } {
    const instanced: SharedShape[] = [];
    const flat: ServerMeshData[] = [];
    for (const shape of shapes ?? []) {
      const candidates: SharedShapeOccurrence[] = [];
      for (const occ of shape.occurrences) {
        if (instanceCandidate(occ)) candidates.push(occ);
        else flat.push(occurrenceMesh(shape, occ));
      }
      if (candidates.length === 0) continue;
      const key = shape.stream_wide ? `${shape.vertex_start}:${shape.index_start}` : null;
      const total = (key === null ? 0 : this.seen.get(key) ?? 0) + candidates.length;
      if (key !== null) this.seen.set(key, total);
      if (total >= INSTANCE_MIN_OCCURRENCES) instanced.push({ ...shape, occurrences: candidates });
      else for (const occ of candidates) flat.push(occurrenceMesh(shape, occ));
    }
    return { instanced, flat };
  }
}

/** Widen `into` by `from`. */
export function mergeBounds(into: Bounds3D, from: Bounds3D): void {
  into.min.x = Math.min(into.min.x, from.min.x);
  into.min.y = Math.min(into.min.y, from.min.y);
  into.min.z = Math.min(into.min.z, from.min.z);
  into.max.x = Math.max(into.max.x, from.max.x);
  into.max.y = Math.max(into.max.y, from.max.y);
  into.max.z = Math.max(into.max.z, from.max.z);
}

/** The IFNL key that joins one stream-wide block's records across shards, or none. */
function templateKey(shape: SharedShape): [number, number] | undefined {
  if (!shape.stream_wide || shape.vertex_start >= 0xffff_ffff) return undefined;
  return [shape.vertex_start + 1, shape.index_start];
}

/** One shard holding every shape and occurrence of a batch, or `null` when there are none. */
export function encodeSharedShapeShard(shapes: readonly SharedShape[]): ArrayBuffer | null {
  const templates: InstancedShardTemplateInput[] = [];
  const instances: InstancedShardInstanceInput[] = [];
  for (const shape of shapes) {
    if (shape.occurrences.length === 0) continue;
    const templateIndex = templates.length;
    const key = templateKey(shape);
    templates.push({ positions: shape.positions, normals: shape.normals, indices: shape.indices, origin: [0, 0, 0], ...(key ? { key } : {}) });
    for (const occ of shape.occurrences) {
      instances.push({
        templateIndex,
        entityId: occ.express_id,
        color: occ.color,
        transform: instanceTransform(occ),
        ...(occ.geometry_item_id !== undefined ? { itemId: occ.geometry_item_id } : {}),
        ...(occ.metallic !== undefined ? { metallic: occ.metallic } : {}),
        ...(occ.roughness !== undefined ? { roughness: occ.roughness } : {}),
      });
    }
  }
  return instances.length > 0 ? encodeInstancedShard(templates, instances) : null;
}

/** What a batch's shapes add: occurrences and the triangles they draw. */
export function sharedShapeCounts(shapes: readonly SharedShape[]): { occurrences: number; vertices: number; triangles: number } {
  let occurrences = 0, vertices = 0, triangles = 0;
  for (const shape of shapes) {
    occurrences += shape.occurrences.length;
    vertices += (shape.positions.length / 3) * shape.occurrences.length;
    triangles += (shape.indices.length / 3) * shape.occurrences.length;
  }
  return { occurrences, vertices, triangles };
}

/**
 * Grow `bounds` by every occurrence's world vertices, and `boxes` by each
 * occurrence's own box per express id, both in the server's shifted Y-up
 * frame. Same corruption filter as `updateBoundsFromPositions`: a vertex is
 * skipped when its rotated local coordinate is not finite or beyond
 * `MAX_VALID_COORD`, which is what the flat path tested after rotating.
 */
export function growBySharedShapes(bounds: Bounds3D, shapes: readonly SharedShape[], boxes?: Map<number, EntityWorldAabb>): void {
  for (const shape of shapes) {
    const p = shape.positions;
    for (const occ of shape.occurrences) {
      const r = occ.rotation ?? IDENTITY;
      const [ox, oy, oz] = occ.origin;
      let box = boxes?.get(occ.express_id);
      for (let i = 0; i < p.length; i += 3) {
        const x = r[0] * p[i] + r[1] * p[i + 1] + r[2] * p[i + 2];
        const y = r[3] * p[i] + r[4] * p[i + 1] + r[5] * p[i + 2];
        const z = r[6] * p[i] + r[7] * p[i + 1] + r[8] * p[i + 2];
        if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
          && Math.abs(x) < MAX_VALID_COORD && Math.abs(y) < MAX_VALID_COORD && Math.abs(z) < MAX_VALID_COORD)) continue;
        const wx = x + ox, wy = y + oy, wz = z + oz;
        if (wx < bounds.min.x) bounds.min.x = wx;
        if (wy < bounds.min.y) bounds.min.y = wy;
        if (wz < bounds.min.z) bounds.min.z = wz;
        if (wx > bounds.max.x) bounds.max.x = wx;
        if (wy > bounds.max.y) bounds.max.y = wy;
        if (wz > bounds.max.z) bounds.max.z = wz;
        if (boxes) {
          if (!box) {
            box = { min: [wx, wy, wz], max: [wx, wy, wz] };
            boxes.set(occ.express_id, box);
          }
          if (wx < box.min[0]) box.min[0] = wx;
          if (wy < box.min[1]) box.min[1] = wy;
          if (wz < box.min[2]) box.min[2] = wz;
          if (wx > box.max[0]) box.max[0] = wx;
          if (wy > box.max[1]) box.max[1] = wy;
          if (wz > box.max[2]) box.max[2] = wz;
        }
      }
    }
  }
}

/**
 * `GeometryResult.instancedGeometryAabbs` for a processed model: the boxes of
 * entities drawn ONLY through instances (an entity with any flat mesh is
 * enumerated through it already), moved from the shifted frame to absolute
 * world by `originShift`, as the field's contract asks.
 */
export function instancedOnlyAabbs(
  boxes: ReadonlyMap<number, EntityWorldAabb>,
  flatIds: ReadonlySet<number>,
  originShift: { x: number; y: number; z: number },
): Map<number, EntityWorldAabb> | undefined {
  const out = new Map<number, EntityWorldAabb>();
  const s = [originShift.x, originShift.y, originShift.z];
  for (const [id, box] of boxes) {
    if (flatIds.has(id)) continue;
    out.set(id, { min: [box.min[0] + s[0], box.min[1] + s[1], box.min[2] + s[2]], max: [box.max[0] + s[0], box.max[1] + s[1], box.max[2] + s[2]] });
  }
  return out.size > 0 ? out : undefined;
}
