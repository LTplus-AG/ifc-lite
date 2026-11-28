/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keep the server's shared shapes shared on the client.
 *
 * With `parquet_layout=shared-shapes` (#3888), and across batches with
 * `stream_shapes=cross-batch` (#5407), several mesh rows name ONE vertex and
 * index block, each placed by its own `origin` and `rot0..rot8`
 * (`world = origin + R * p`). `buildMeshesFromTables` copies that block into
 * every row's own mesh, so a model the server sent with each repeated shape
 * once arrives in the viewer with every occurrence expanded: more triangles,
 * more decode time, more memory than a local parse, which keeps such shapes
 * GPU-instanced.
 *
 * `buildSharedShapesFromTables` instead returns the block once with its
 * occurrences, so a consumer can hand them to the renderer as instances. A row
 * becomes an occurrence only when its block is named by another row of the
 * same table set or by an earlier batch (`SharedShapeTracker`); every other row
 * decodes exactly as `buildMeshesFromTables` would. Rows carrying a material
 * layer id or a non-occurrence geometry class always stay flat, because an
 * instance record has no field for them.
 *
 * Nothing on the wire changes. A payload without shared blocks (a
 * `-parquet-v5` cache, or a server that ignored the layout opt-in) has no
 * block named twice, so it decodes to the same flat meshes as before.
 */

import type { MeshData } from './types.js';
import { buildFlatMesh, readFlatBlock, readFlatColumns, type FlatColumns } from './parquet-flat-rows.js';
import { readSourceId, transformFields } from './parquet-columns.js';
import type { ArrowTableLike } from './parquet-tables.js';

/** One placement of a shared shape: `world = origin + R * position`, Y-up metres. */
export interface SharedShapeOccurrence {
  express_id: number;
  ifc_type: string;
  color: [number, number, number, number];
  /** `[0, 0, 0]` for a world-baked row. */
  origin: [number, number, number];
  /** Row-major 3×3; absent means identity. */
  rotation?: number[];
  geometry_item_id?: number;
  metallic?: number;
  roughness?: number;
}

/** One vertex/index block the server sent once, and every row placing it. */
export interface SharedShape {
  /** Where the block starts in the table set it was read from (vertex rows / indices). */
  vertex_start: number;
  index_start: number;
  /**
   * Whether `vertex_start` / `index_start` name this block for the WHOLE model
   * (a cross-batch stream or a single blob), so a consumer may join shapes of
   * different batches by them. False for a stream batch decoded on its own,
   * whose offsets restart per batch.
   */
  stream_wide: boolean;
  /** Y-up, relative to each occurrence's origin, unrotated. */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  occurrences: SharedShapeOccurrence[];
}

/** Flat meshes plus the shapes whose rows were kept as occurrences. */
export interface SharedShapeGeometry {
  meshes: MeshData[];
  shapes: SharedShape[];
}

/**
 * The blocks earlier table sets of one stream already named, so a later row
 * naming one becomes an occurrence even when it is alone in its own batch.
 * Only meaningful when block offsets are whole-stream (cross-batch streams).
 */
export class SharedShapeTracker {
  readonly seen = new Set<string>();
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function blockKey(c: FlatColumns, i: number): string {
  return `${c.vertexStarts[i]}:${c.vertexCounts[i]}:${c.indexStarts[i]}:${c.indexCounts[i]}`;
}

/** Whether row `i` can be an instance record: an occurrence with geometry and no material-layer id. */
function instanceable(c: FlatColumns, i: number): boolean {
  if (c.indexCounts[i] === 0 || c.vertexCounts[i] === 0) return false;
  if ((c.extra.geometryClass?.[i] || 0) !== 0) return false;
  return readSourceId(c.extra.materialId, i) === undefined;
}

function rotationOf(c: FlatColumns, i: number): number[] | undefined {
  if (!c.rotation) return undefined;
  const r = c.rotation.map((col) => col[i]);
  if (!r.every(Number.isFinite)) {
    throw new Error(`Malformed Parquet geometry: non-finite rotation value for row ${i} (rot=[${r.join(', ')}])`);
  }
  return r.every((v, k) => v === IDENTITY[k]) ? undefined : r;
}

function occurrenceOf(c: FlatColumns, i: number): SharedShapeOccurrence {
  // `buildFlatMesh`'s field rules, applied to the row without copying its block.
  const fields = transformFields(i, c.extra);
  const rotation = rotationOf(c, i);
  return {
    express_id: c.expressIds[i],
    ifc_type: (c.ifcTypes?.get(i) as string) ?? 'Unknown',
    color: [c.colorR[i], c.colorG[i], c.colorB[i], c.colorA[i]],
    origin: fields.origin ?? [0, 0, 0],
    ...(rotation ? { rotation } : {}),
    ...(fields.geometry_item_id !== undefined ? { geometry_item_id: fields.geometry_item_id } : {}),
    ...(fields.metallic !== undefined ? { metallic: fields.metallic } : {}),
    ...(fields.roughness !== undefined ? { roughness: fields.roughness } : {}),
  };
}

/**
 * Decode one flat table set, keeping every block named by more than one row
 * (here or, with `tracker`, in an earlier table set of the same stream) as one
 * {@link SharedShape}. Pass no tracker for a table set whose offsets are its
 * own (a single blob, or a stream batch that states no bases): its shapes are
 * then joined within it only.
 */
export function buildSharedShapesFromTables(
  meshArrow: ArrowTableLike,
  vertexArrow: ArrowTableLike,
  indexArrow: ArrowTableLike,
  tracker?: SharedShapeTracker,
  streamWide = tracker !== undefined,
): SharedShapeGeometry {
  const c = readFlatColumns(meshArrow, vertexArrow, indexArrow);
  const counts = new Map<string, number>();
  const keys: (string | null)[] = new Array(c.meshCount);
  for (let i = 0; i < c.meshCount; i++) {
    const key = instanceable(c, i) ? blockKey(c, i) : null;
    keys[i] = key;
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const meshes: MeshData[] = [];
  const shapes = new Map<string, SharedShape>();
  for (let i = 0; i < c.meshCount; i++) {
    const key = keys[i];
    const shared = key !== null && ((counts.get(key) ?? 0) > 1 || tracker?.seen.has(key) === true);
    if (!shared) {
      meshes.push(buildFlatMesh(c, i));
      continue;
    }
    let shape = shapes.get(key);
    if (!shape) {
      const block = readFlatBlock(c, i);
      shape = { vertex_start: c.vertexStarts[i], index_start: c.indexStarts[i], stream_wide: streamWide, ...block, occurrences: [] };
      shapes.set(key, shape);
    }
    shape.occurrences.push(occurrenceOf(c, i));
  }
  if (tracker) for (const key of keys) if (key !== null) tracker.seen.add(key);
  return { meshes, shapes: [...shapes.values()] };
}
