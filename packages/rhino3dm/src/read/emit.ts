/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Part } from './geometry.js';
import { plural, type Report } from './report.js';
import type {
  RhinoImportCurve, RhinoImportDefinition, RhinoImportInstance, RhinoImportMesh,
  RhinoImportPointCloud, RhinoImportTextDot, RhinoRgba,
} from './types.js';
import { determinant3, hasLinearPart, transformNormals, transformPoint, transformVectors, type Xform } from './xform.js';

export type DrawnPart = Exclude<Part, { kind: 'instance' }>;

/** A block's own meshes, as the output definition and its triangle count. */
export interface BlockMeshes { name: string; meshes: RhinoImportDefinition['meshes']; triangles: number }

/** Reverse each triangle, for geometry placed by a mirroring transform. */
function flipWinding(indices: Uint32Array): Uint32Array {
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i += 3) { out[i] = indices[i]; out[i + 1] = indices[i + 2]; out[i + 2] = indices[i + 1]; }
  return out;
}

/** Most text dots one file may return. Dots are free of the triangle budget, so blocks could otherwise multiply them without bound. */
export const MAX_TEXT_DOTS = 100_000;

/**
 * Collects the output geometry and enforces the drawing budget. `entity`
 * holds the index of the source object until the reader maps it to an entity.
 */
export class Emitter {
  readonly meshes: RhinoImportMesh[] = [];
  readonly definitions: RhinoImportDefinition[] = [];
  readonly instances: RhinoImportInstance[] = [];
  readonly pointClouds: RhinoImportPointCloud[] = [];
  readonly curves: RhinoImportCurve[] = [];
  readonly textDots: RhinoImportTextDot[] = [];
  /** True once a part did not fit: nothing but text dots is drawn after that. */
  exhausted = false;
  private readonly definitionIndex = new Map<string, number>();
  private readonly emitted = new Set<ArrayBufferLike>();

  constructor(private readonly bake: boolean, private trianglesLeft: number, private readonly report: Report) {}

  /** How many records have been drawn so far. */
  size(): number {
    return this.meshes.length + this.instances.length + this.pointClouds.length + this.curves.length + this.textDots.length;
  }

  dotsFull(): boolean { return this.textDots.length >= MAX_TEXT_DOTS; }

  /** Count text dots left out at the limit. */
  omitDots(count: number): void {
    if (count === 0) return;
    this.report.skip('TextDot:limit', count);
    this.report.warn('dots', () => `Stopped at ${MAX_TEXT_DOTS.toLocaleString('en-US')} text dots: ${plural(this.report.skipped['TextDot:limit'], 'text dot')} left out.`);
  }

  /** Charge the budget, or stop drawing for the rest of the file. */
  private take(triangles: number): boolean {
    if (this.exhausted || triangles > this.trianglesLeft) { this.exhausted = true; return false; }
    this.trianglesLeft -= triangles;
    return true;
  }

  /** A typed array for the output: the array itself the first time, a copy when it is already there, so a transfer list never names a buffer twice. */
  private own<T extends Float32Array | Uint32Array | Uint8Array>(array: T): T {
    if (!this.emitted.has(array.buffer)) { this.emitted.add(array.buffer); return array; }
    return array.slice() as T;
  }

  /**
   * Draw one part of `object` under `xform` (null for none): the origin moves
   * in f64, the f32 offsets by the 3×3 part only. False when the budget
   * refused it. A part the transform pushes out of the finite range is counted
   * and left out, which keeps the result free of non-finite numbers.
   */
  draw(object: number, part: DrawnPart, xform: Xform | null, color: RhinoRgba): boolean {
    if (part.kind === 'dot' && this.dotsFull()) { this.omitDots(1); return true; }
    const at = part.kind === 'dot' ? part.position : part.origin;
    const origin = xform ? transformPoint(xform, at) : at;
    if (part.kind === 'dot') {
      if (!origin.every(Number.isFinite)) this.report.skip('TextDot:invalid');
      else this.textDots.push({ entity: object, position: origin, text: part.text, color: [...color] });
      return true;
    }
    // A curve or point cloud vertex is charged a third of a triangle, so blocks cannot multiply them without bound.
    if (!this.take(part.kind === 'mesh' ? part.indices.length / 3 : part.positions.length / 9)) return false;
    const linear = xform !== null && hasLinearPart(xform) ? xform : null;
    const positions = linear ? transformVectors(linear, part.positions) : this.own(part.positions);
    if (!origin.every(Number.isFinite) || (linear && !positions.every(Number.isFinite))) {
      this.report.skip('transform:invalid');
      return true;
    }
    if (part.kind === 'curve') this.curves.push({ entity: object, origin, positions, closed: part.closed, color: [...color] });
    else if (part.kind === 'points') this.pointClouds.push({ entity: object, origin, positions, colors: part.colors && this.own(part.colors), color: [...color] });
    else {
      // A mirroring placement turns each triangle inside out, so its winding is reversed.
      const mirrored = linear !== null && determinant3(linear) < 0;
      this.meshes.push({
        entity: object, origin, positions, color: [...color],
        normals: linear ? transformNormals(linear, part.normals) : this.own(part.normals),
        indices: mirrored ? flipWinding(part.indices) : this.own(part.indices),
      });
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
      return block.meshes.every(mesh => this.draw(object, { kind: 'mesh', ...mesh }, xform, mesh.color ?? color));
    }
    if (!this.take(block.triangles)) return false;
    let definition = this.definitionIndex.get(id);
    if (definition === undefined) {
      definition = this.definitions.length;
      this.definitionIndex.set(id, definition);
      this.definitions.push({ name: block.name, meshes: block.meshes.map(m => ({ ...m, positions: this.own(m.positions), normals: this.own(m.normals), indices: this.own(m.indices) })) });
    }
    this.instances.push({ entity: object, definition, transform: xform, color: [...color] });
    return true;
  }
}
