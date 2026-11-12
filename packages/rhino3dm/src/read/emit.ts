/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Part } from './geometry.js';
import type {
  RhinoImportCurve, RhinoImportDefinition, RhinoImportGeometry, RhinoImportInstance, RhinoImportMesh,
  RhinoImportPointCloud, RhinoImportTextDot, RhinoRgba,
} from './types.js';
import { determinant3, hasLinearPart, transformNormals, transformPoint, transformVectors, type Xform } from './xform.js';

type MeshPart = Extract<Part, { kind: 'mesh' }>;
export type DrawnPart = Exclude<Part, { kind: 'instance' }>;

/** A block's own meshes, as the output definition and its triangle count. */
export interface BlockMeshes { name: string; meshes: RhinoImportDefinition['meshes']; meshParts: MeshPart[]; triangles: number }

/** Reverse each triangle, for geometry placed by a mirroring transform. */
function flipWinding(indices: Uint32Array): Uint32Array {
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i += 3) { out[i] = indices[i]; out[i + 1] = indices[i + 2]; out[i + 2] = indices[i + 1]; }
  return out;
}

/**
 * Collects the output geometry and enforces the triangle budget. `entity`
 * holds the index of the source object until the reader maps it to an entity.
 */
export class Emitter {
  readonly meshes: RhinoImportMesh[] = [];
  readonly definitions: RhinoImportDefinition[] = [];
  readonly instances: RhinoImportInstance[] = [];
  readonly pointClouds: RhinoImportPointCloud[] = [];
  readonly curves: RhinoImportCurve[] = [];
  readonly textDots: RhinoImportTextDot[] = [];
  /** True once a part did not fit: nothing with triangles is drawn after that. */
  exhausted = false;
  private readonly definitionIndex = new Map<string, number>();

  constructor(private readonly bake: boolean, private trianglesLeft: number) {}

  /** How many records have been drawn so far. */
  size(): number {
    return this.meshes.length + this.instances.length + this.pointClouds.length + this.curves.length + this.textDots.length;
  }

  /** Charge the budget, or stop drawing triangles for the rest of the file. */
  private take(triangles: number): boolean {
    if (this.exhausted || triangles > this.trianglesLeft) { this.exhausted = true; return false; }
    this.trianglesLeft -= triangles;
    return true;
  }

  /**
   * Move a part by `xform`: the origin in f64, the f32 offsets by the 3×3
   * part only. `shared` copies buffers that would otherwise appear twice in
   * the output, which a transfer list forbids.
   */
  private placed<T extends { origin: [number, number, number]; positions: Float32Array }>(part: T, xform: Xform | null, shared: boolean) {
    const linear = xform !== null && hasLinearPart(xform);
    return {
      linear,
      origin: xform ? transformPoint(xform, part.origin) : part.origin,
      positions: linear ? transformVectors(xform, part.positions) : shared ? part.positions.slice() : part.positions,
    };
  }

  private mesh(part: MeshPart, xform: Xform | null, shared: boolean): RhinoImportGeometry {
    const { linear, origin, positions } = this.placed(part, xform, shared);
    if (!linear || !xform) {
      return { origin, positions, normals: shared ? part.normals.slice() : part.normals, indices: shared ? part.indices.slice() : part.indices };
    }
    const mirrored = determinant3(xform) < 0;
    return {
      origin, positions, normals: transformNormals(xform, part.normals),
      indices: mirrored ? flipWinding(part.indices) : shared ? part.indices.slice() : part.indices,
    };
  }

  /** Draw one part of `object` under `xform` (null for none). False when the budget refused it. */
  draw(object: number, part: DrawnPart, xform: Xform | null, color: RhinoRgba, shared = false): boolean {
    if (part.kind === 'mesh') {
      if (!this.take(part.indices.length / 3)) return false;
      this.meshes.push({ entity: object, ...this.mesh(part, xform, shared), color });
    } else if (part.kind === 'dot') {
      this.textDots.push({ entity: object, position: xform ? transformPoint(xform, part.position) : part.position, text: part.text, color });
    } else {
      const { origin, positions } = this.placed(part, xform, shared);
      if (part.kind === 'curve') this.curves.push({ entity: object, origin, positions, closed: part.closed, color });
      else this.pointClouds.push({ entity: object, origin, positions, colors: shared && part.colors ? part.colors.slice() : part.colors, color });
    }
    return true;
  }

  /**
   * Place a block's own meshes for `object`: one instance record, or baked
   * copies under `bakeInstances`. Either way the budget is charged the block's
   * triangles once per placement. False when the budget refused it.
   */
  place(object: number, id: string, block: BlockMeshes, xform: Xform, color: RhinoRgba): boolean {
    if (block.meshes.length === 0) return true;
    if (this.bake) {
      return block.meshParts.every((part, i) => this.draw(object, part, xform, block.meshes[i].color ?? color, true));
    }
    if (!this.take(block.triangles)) return false;
    let definition = this.definitionIndex.get(id);
    if (definition === undefined) {
      definition = this.definitions.length;
      this.definitionIndex.set(id, definition);
      this.definitions.push({ name: block.name, meshes: block.meshes });
    }
    this.instances.push({ entity: object, definition, transform: xform, color });
    return true;
  }
}
