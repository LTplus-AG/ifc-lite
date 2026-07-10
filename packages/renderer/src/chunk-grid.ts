/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spatial chunk grid for batch bucketing (issue #1682, phase 2 of the
 * chunked-residency plan).
 *
 * Today a colour bucket spans the whole model, so its world AABB is
 * model-sized and per-batch frustum/contribution culling almost never fires.
 * Chunking adds a spatial dimension to the bucket key: meshes land in
 * `cell~colour` buckets, where `cell` is the axis-aligned grid cell of the
 * mesh's world anchor point. Batches become spatially compact, so the
 * existing per-batch culls (and, later, per-chunk residency/eviction) get
 * real purchase. A mesh is never split across cells — the anchor decides
 * membership for all of its vertices, exactly like the mesh-never-splits
 * rule in Cesium-style chunk planners.
 *
 * The anchor is `origin + first vertex`: `MeshData.positions` are stored in
 * the element's local frame with `world = origin + position` (see
 * `MeshData.origin`), so any vertex is a true world point of the mesh. The
 * first vertex is O(1), deterministic, and — unlike `localBounds` — needs no
 * placement transform (`localBounds` is a PRE-placement box, so
 * `origin + centre(localBounds)` would be wrong under rotation).
 *
 * Purely a reorganization: batches keep the shared scene frame origin, so
 * vertex relativization, the draw path, and highlight bit-coincidence are
 * untouched. Chunking multiplies batch count by the colours-per-cell factor;
 * cell size trades culling granularity against draw calls.
 */

/** Spatial slice of MeshData needed to derive a chunk cell. */
export interface ChunkAnchorSource {
  /** Element local-frame origin: world = origin + position. Absent = [0,0,0]. */
  origin?: [number, number, number];
  positions: Float32Array;
}

export interface SpatialChunkingConfig {
  /** Grid cell edge length in world units (metres for IFC models). */
  cellSize: number;
}

/**
 * Default cell edge. Big enough that a small building stays one cell per
 * colour (zero draw-call growth on FZK-class models), small enough that a
 * city-block model splits into cullable tiles. Tune against the benchmark's
 * drawCalls metric before flipping the feature default on.
 */
export const DEFAULT_CHUNK_CELL_SIZE = 32;

/**
 * Grid cell key ("cx,cy,cz") of the mesh's world anchor point.
 * Empty meshes anchor at their origin. NaN coordinates land in a dedicated
 * "nan" cell rather than poisoning arithmetic downstream.
 */
export function chunkCellKey(mesh: ChunkAnchorSource, cellSize: number): string {
  const o = mesh.origin;
  const ox = o ? o[0] : 0;
  const oy = o ? o[1] : 0;
  const oz = o ? o[2] : 0;
  const hasVertex = mesh.positions.length >= 3;
  const x = ox + (hasVertex ? mesh.positions[0] : 0);
  const y = oy + (hasVertex ? mesh.positions[1] : 0);
  const z = oz + (hasVertex ? mesh.positions[2] : 0);
  const cx = Math.floor(x / cellSize);
  const cy = Math.floor(y / cellSize);
  const cz = Math.floor(z / cellSize);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) {
    return 'nan';
  }
  return `${cx},${cy},${cz}`;
}

/**
 * Bucket BASE key for a mesh (before any "#N" overflow suffix from
 * `resolveActiveBucket`): plain colour key when chunking is off,
 * `cell~colour` when on. Every bucket-key derivation site in the Scene MUST
 * go through this so a mesh resolves to the same bucket during streaming,
 * finalize re-grouping, recolour moves, and partial-batch piece filtering.
 * ("~" cannot collide: colour keys are `r|g|b|a` integers, cell keys are
 * `cx,cy,cz` integers, and the overflow suffix uses "#".)
 */
export function bucketBaseKeyFor(
  mesh: ChunkAnchorSource,
  colorKey: string,
  chunking: SpatialChunkingConfig | null,
): string {
  if (!chunking) return colorKey;
  return `${chunkCellKey(mesh, chunking.cellSize)}~${colorKey}`;
}
