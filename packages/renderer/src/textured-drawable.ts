/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Material, MeshFinish } from './types.js';
import type { MeshData } from '@ifc-lite/geometry';

/** A surface-textured mesh (#961): its own interleaved vertex buffer (with a UV
 *  lane), index buffer, per-mesh uniform buffer, GPU texture + sampler, and a
 *  bindGroup wiring all three. Drawn per-mesh in a dedicated sub-pass. */
export interface TexturedMesh {
  expressId: number;
  modelIndex?: number;
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  uniformBuffer: GPUBuffer;
  texture: GPUTexture;
  sampler: GPUSampler;
  bindGroup: GPUBindGroup;
  /** Authored tint (multiplies the sampled texel); white = texture passthrough. */
  color: [number, number, number, number];
  /** A caller-supplied finish, mirroring {@link Mesh.material}. */
  material?: Material;
  /** IFC-authored finish (#5582), copied from `MeshData.material` at upload
   *  (#5984); like {@link Mesh.finish}, `packMeshMaterial` prefers it. */
  finish?: MeshFinish;
  /**
   * The mesh's per-element local frame (`MeshData.origin`, already Y-up) — the
   * renderer must reconstruct `world = origin + position`.
   *
   * The interleaved vertex buffer stores positions RELATIVE to this, which is
   * the whole point of the local frame (#1114): keeping the world magnitude out
   * of f32 so building-scale coordinates don't collapse adjacent vertices into
   * degenerate fans. So it is applied as the draw's model translation, never
   * folded back into the vertex data.
   *
   * `[0, 0, 0]` for the #961 orphan type-geometry path, whose positions are
   * already absolute (`transform_mesh_local`); non-zero for the #1793
   * occurrence path (`apply_submesh_placement` → `transform_mesh_world`), which
   * is what real exporters write. Dropping it drew every textured occurrence
   * collapsed toward the world origin (#1973).
   */
  origin: [number, number, number];
  /** Set when `texture` lives in the shared registry (#1781: one GPU texture
   *  per `IfcImageTexture`, sampled by many meshes) — released by refcount,
   *  never destroyed per-mesh. Undefined for per-mesh #961 blob/pixel uploads. */
  sharedTextureKey?: number;
}

/** Weak references preserve identity without retaining released CPU geometry or bitmaps. */
export interface TexturedSource {
  positions: MeshData['positions'];
  fields: (WeakRef<object> | undefined)[];
  geometryItemId: number | undefined;
  modelIndex: number | undefined;
}
function sourceFields(piece: MeshData): (object | undefined)[] {
  return [piece.indices, piece.normals, piece.uvs, piece.entityIds, piece.texture, piece.textureRef, piece.textureBitmap];
}
export function captureTexturedSource(piece: MeshData): TexturedSource {
  return { positions: piece.positions, fields: sourceFields(piece).map((field) => field ? new WeakRef(field) : undefined),
    geometryItemId: piece.geometryItemId, modelIndex: piece.modelIndex };
}

type DrawableScene = { getPickGeometryRevision(): number; getTexturedMeshes(): readonly TexturedMesh[] };
const lookups = new WeakMap<DrawableScene, { revision: number; byPositions: WeakMap<MeshData['positions'], TexturedMesh[]> }>();

/** A retired or replaced drawable cannot survive a scene revision in this lookup. */
export function findTexturedDrawable(scene: DrawableScene, piece: MeshData, sources: WeakMap<TexturedMesh, TexturedSource>, expressId = piece.expressId): TexturedMesh | undefined {
  let lookup = lookups.get(scene);
  const revision = scene.getPickGeometryRevision();
  if (!lookup || lookup.revision !== revision) {
    lookup = { revision, byPositions: new WeakMap() };
    for (const drawable of scene.getTexturedMeshes()) {
      const key = sources.get(drawable)?.positions;
      if (!key) continue;
      const list = lookup.byPositions.get(key);
      if (list) list.push(drawable); else lookup.byPositions.set(key, [drawable]);
    }
    lookups.set(scene, lookup);
  }
  const fields = sourceFields(piece);
  return lookup.byPositions.get(piece.positions)?.find((drawable) => {
    const source = sources.get(drawable)!;
    return drawable.expressId === expressId && source.modelIndex === piece.modelIndex
      && source.geometryItemId === piece.geometryItemId
      && drawable.origin.every((value, axis) => value === (piece.origin?.[axis] ?? 0))
      && drawable.color.every((value, lane) => value === piece.color[lane])
      && source.fields.every((field, index) => field
        ? fields[index] !== undefined && field.deref() === fields[index]
        : fields[index] === undefined);
  });
}
