/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which entities' meshes have free edges, i.e. are surfaces rather than solids (#8664).
 *
 * Why the mesh and not the IFC representation: of 439 IfcFaceBasedSurfaceModel
 * products measured on a real corpus, 318 mesh perfectly closed and are volumes in
 * all but name, so the representation type alone would hollow them out.
 *
 * Why the whole entity and not each MeshData: one material layer's band is open by
 * design (the slicer leaves the interface planes uncapped), and only the union of
 * an entity's sub-meshes is watertight.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { CutSegment, EntityKey } from './types.js';
import { makeEntityKey } from './types.js';

/** Vertex weld grid in metres. Faces are not guaranteed to share vertices. */
const WELD_GRID = 1e-3;
/** Two welded ids pack into one safe integer below this count (2^26 squared is 2^52). */
const ID_RADIX = 0x4000000;

export class OpenSurfaceIndex {
  private byEntity: Map<EntityKey, MeshData[]> | null = null;
  private readonly known = new Map<EntityKey, boolean>();

  /**
   * `meshes`: the whole input, grouped lazily per entity. A streamed drawing
   * instead resolves the entities it needs while it replays its source and
   * hands them over through {@link OpenSurfaceIndex.resolved}.
   */
  constructor(private readonly meshes: readonly MeshData[]) {}

  /** An index whose answers are already known (see {@link OpenSurfaceAccumulator}). */
  static resolved(known: ReadonlyMap<EntityKey, boolean>): OpenSurfaceIndex {
    const index = new OpenSurfaceIndex([]);
    for (const [key, open] of known) index.known.set(key, open);
    return index;
  }

  /** Whether this cut crosses a real boundary of the entity: chain ends left, and free edges. */
  cutsOpen(key: EntityKey, segments: readonly CutSegment[]): boolean {
    return hasChainEnd(segments) && this.has(key);
  }

  /** Lazy per entity, memoised: most entities never get here (see {@link cutsOpen}). */
  has(key: EntityKey): boolean {
    let open = this.known.get(key);
    if (open === undefined) {
      const parity = new FreeEdgeParity();
      for (const mesh of this.entityMeshes().get(key) ?? []) parity.add(mesh);
      open = parity.open;
      this.known.set(key, open);
    }
    return open;
  }

  private entityMeshes(): Map<EntityKey, MeshData[]> {
    if (this.byEntity) return this.byEntity;
    const byEntity = new Map<EntityKey, MeshData[]>();
    for (const mesh of this.meshes) {
      const key = meshEntityKey(mesh);
      const bucket = byEntity.get(key);
      if (bucket) bucket.push(mesh);
      else byEntity.set(key, [mesh]);
    }
    this.byEntity = byEntity;
    return byEntity;
  }
}

const meshEntityKey = (mesh: MeshData): EntityKey => makeEntityKey(mesh.modelIndex || 0, mesh.expressId);

/**
 * The entities whose cut leaves chain ends: the only ones the polygon builder
 * asks {@link OpenSurfaceIndex.cutsOpen} about past its chain-end test.
 */
export function openSurfaceCandidates(segments: readonly CutSegment[]): Set<EntityKey> {
  const byEntity = new Map<EntityKey, CutSegment[]>();
  for (const segment of segments) {
    const key = makeEntityKey(segment.modelIndex, segment.entityId);
    const bucket = byEntity.get(key);
    if (bucket) bucket.push(segment);
    else byEntity.set(key, [segment]);
  }
  const out = new Set<EntityKey>();
  for (const [key, bucket] of byEntity) if (hasChainEnd(bucket)) out.add(key);
  return out;
}

/**
 * Free-edge state of the candidate entities, fed one batch of meshes at a time
 * (a replay of a streamed source). Holds welded edge parity only, never a mesh,
 * so it is bounded by the candidates' geometry, not by the model.
 */
export class OpenSurfaceAccumulator {
  private readonly parity = new Map<EntityKey, FreeEdgeParity>();

  constructor(candidates: ReadonlySet<EntityKey>) {
    for (const key of candidates) this.parity.set(key, new FreeEdgeParity());
  }

  get needed(): boolean { return this.parity.size > 0; }

  add(meshes: readonly MeshData[]): void {
    for (const mesh of meshes) this.parity.get(meshEntityKey(mesh))?.add(mesh);
  }

  index(): OpenSurfaceIndex {
    const known = new Map<EntityKey, boolean>();
    for (const [key, parity] of this.parity) known.set(key, parity.open);
    return OpenSurfaceIndex.resolved(known);
  }
}

/** Parity over welded endpoints: a section of a closed mesh has no chain ends. */
function hasChainEnd(segments: readonly CutSegment[]): boolean {
  const oddEnds = new Set<string>();
  for (const { p0_2d, p1_2d } of segments) {
    for (const { x, y } of [p0_2d, p1_2d]) {
      const end = `${Math.round(x / WELD_GRID)},${Math.round(y / WELD_GRID)}`;
      if (!oddEnds.delete(end)) oddEnds.add(end);
    }
  }
  return oddEnds.size > 0;
}

/**
 * Parity over welded edges: a closed mesh uses every edge an even number of times,
 * so toggling each use leaves only the free ones. World space, since sub-meshes of
 * one entity need not share an origin. Fed one sub-mesh at a time, in any batches.
 */
class FreeEdgeParity {
  private readonly weldIds = new Map<string, number>();
  private readonly oddEdges = new Set<number>();

  get open(): boolean { return this.oddEdges.size > 0; }

  add({ positions, indices, origin }: MeshData): void {
    const { weldIds, oddEdges } = this;
    const vertexIds = new Int32Array(positions.length / 3).fill(-1);
    const weldedId = (vertex: number): number => {
      if (vertexIds[vertex] !== -1) return vertexIds[vertex];
      const base = vertex * 3;
      const key = [0, 1, 2]
        .map((axis) => Math.round((positions[base + axis] + (origin?.[axis] ?? 0)) / WELD_GRID))
        .join(',');
      let id = weldIds.get(key);
      if (id === undefined) {
        id = weldIds.size;
        weldIds.set(key, id);
      }
      vertexIds[vertex] = id;
      return id;
    };

    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = weldedId(indices[t]);
      const b = weldedId(indices[t + 1]);
      const c = weldedId(indices[t + 2]);
      if (a === b || b === c || c === a) continue; // collapsed by the weld: has no edges
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const edge = Math.min(p, q) * ID_RADIX + Math.max(p, q);
        if (!oddEdges.delete(edge)) oddEdges.add(edge);
      }
    }
  }
}
