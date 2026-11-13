/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Part } from './geometry.js';
import { plural, type Report } from './report.js';
import type {
  RhinoImportCurve, RhinoImportDefinition, RhinoImportInstance, RhinoImportMesh,
  RhinoImportPointCloud, RhinoImportTextDot, RhinoRgba,
} from './types.js';
import type { RhinoVector3 } from '../types.js';
import { determinant3, hasLinearPart, keepsF32, reach, transformNormals, transformPoint, transformVectors, type Xform } from './xform.js';

export type DrawnPart = Exclude<Part, { kind: 'instance' }>;

/** A record as drawn: the reader adds `hidden` once it maps the record to its entity. */
type Drawn<T> = Omit<T, 'hidden'>;

/** A block's own meshes, as the output definition, their `cost`, and per axis how far any vertex is from the block's origin. */
export interface BlockMeshes { name: string; meshes: RhinoImportDefinition['meshes']; cost: number; reach: RhinoVector3 }

/**
 * What a part costs the triangle budget: its triangles, or a third of a triangle per vertex,
 * rounded up, when that is more. Memory follows the vertex buffers as well as the triangles, and
 * nothing makes a mesh's triangles use its vertices. A mesh whose every vertex is in some triangle
 * has at most three per triangle and costs its triangles alone. Whole numbers, so a block's cost
 * is exactly the sum of its meshes' and a placement admitted whole is never cut by rounding.
 */
export function cost(part: { positions: Float32Array; indices?: Uint32Array }): number {
  return Math.max((part.indices?.length ?? 0) / 3, Math.ceil(part.positions.length / 9));
}

/** Reverse each triangle, for geometry placed by a mirroring transform. */
function flipWinding(indices: Uint32Array): Uint32Array {
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i += 3) { out[i] = indices[i]; out[i + 1] = indices[i + 2]; out[i + 2] = indices[i + 1]; }
  return out;
}

/**
 * Most text dots one file's read may visit, returned or left out as invalid. Dots are free of
 * the triangle budget, so blocks could otherwise multiply them without bound.
 */
export const MAX_TEXT_DOTS = 100_000;

/**
 * Collects the output geometry and enforces the drawing budget. `entity`
 * holds the index of the source object until the reader maps it to an entity.
 */
export class Emitter {
  readonly meshes: Drawn<RhinoImportMesh>[] = [];
  readonly definitions: RhinoImportDefinition[] = [];
  readonly instances: Drawn<RhinoImportInstance>[] = [];
  readonly pointClouds: Drawn<RhinoImportPointCloud>[] = [];
  readonly curves: Drawn<RhinoImportCurve>[] = [];
  readonly textDots: Drawn<RhinoImportTextDot>[] = [];
  /** True once a part did not fit: nothing but text dots is drawn after that. */
  exhausted = false;
  private readonly definitionIndex = new Map<string, number>();
  private readonly emitted = new Set<ArrayBufferLike>();
  private readonly reaches = new WeakMap<Float32Array, RhinoVector3>();
  private dotVisits = 0;
  /** Parts left out as `transform:invalid` so far. They cost no triangles, so the block walk charges them itself. */
  outOfRange = 0;

  constructor(private readonly bake: boolean, private trianglesLeft: number, private readonly report: Report) {}

  /** How many records have been drawn so far. */
  size(): number {
    return this.meshes.length + this.instances.length + this.pointClouds.length + this.curves.length + this.textDots.length;
  }

  dotsFull(): boolean { return this.dotVisits >= MAX_TEXT_DOTS; }

  /** Count text dots left out at the limit. */
  omitDots(count: number): void {
    if (count === 0) return;
    this.report.skip('TextDot:limit', count);
    this.report.warn('dots', () => `Stopped after ${MAX_TEXT_DOTS.toLocaleString('en-US')} text dots: ${plural(this.report.skipped['TextDot:limit'], 'text dot')} left out.`);
  }

  /** Whether `triangles` still fit; when they do not, drawing stops for the rest of the file. */
  private fits(triangles: number): boolean {
    if (this.exhausted || triangles > this.trianglesLeft) { this.exhausted = true; return false; }
    return true;
  }

  /** Charge the budget, or stop drawing for the rest of the file. */
  private take(triangles: number): boolean {
    if (!this.fits(triangles)) return false;
    this.trianglesLeft -= triangles;
    return true;
  }

  /** A typed array for the output: the array itself the first time, a copy when it is already there, so a transfer list never names a buffer twice. */
  private own<T extends Float32Array | Uint32Array | Uint8Array>(array: T): T {
    if (!this.emitted.has(array.buffer)) { this.emitted.add(array.buffer); return array; }
    return array.slice() as T;
  }

  /**
   * Whether a part whose origin `xform` moved to `origin` stays in the finite range. Decided from
   * the part's reach, which is measured once, so asking again for another placement costs nothing.
   */
  private inRange(xform: Xform | null, origin: RhinoVector3, positions: Float32Array): boolean {
    if (!origin.every(Number.isFinite)) return false;
    if (!xform || !hasLinearPart(xform)) return true;
    let extent = this.reaches.get(positions);
    if (!extent) this.reaches.set(positions, extent = reach(positions));
    return keepsF32(xform, extent);
  }

  /**
   * Draw one part of `object` under `xform` (null for none): the origin moves
   * in f64, the f32 offsets by the 3×3 part only. False when the budget
   * refused it. A part the transform pushes out of the finite range is counted
   * and left out before the budget is charged, which keeps the result free of
   * non-finite numbers and the budget for what is drawn.
   */
  draw(object: number, part: DrawnPart, xform: Xform | null, color: RhinoRgba): boolean {
    if (part.kind === 'dot' && this.dotsFull()) { this.omitDots(1); return true; }
    const at = part.kind === 'dot' ? part.position : part.origin;
    const origin = xform ? transformPoint(xform, at) : at;
    if (part.kind === 'dot') {
      this.dotVisits++;
      if (!origin.every(Number.isFinite)) this.report.skip('TextDot:invalid');
      else this.textDots.push({ entity: object, position: origin, text: part.text, color: [...color] });
      return true;
    }
    if (this.exhausted) return false;
    if (!this.inRange(xform, origin, part.positions)) { this.outOfRange++; this.report.skip('transform:invalid'); return true; }
    if (!this.take(cost(part))) return false;
    const linear = xform !== null && hasLinearPart(xform) ? xform : null;
    const positions = linear ? transformVectors(linear, part.positions) : this.own(part.positions);
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
   * `cost` once per placement. False when the budget refused it.
   *
   * What the budget does no longer depends on `bakeInstances`: both modes
   * admit and charge a placement alike. A placement whose block reach keeps
   * the f32 range is all or nothing, so the block's mesh triangles have to fit
   * before any of them is drawn. That is where the modes used to differ:
   * baking charged mesh by mesh and drew the part that still fitted, so the
   * option decided whether a file read at all.
   *
   * The budget can still cut a placement elsewhere, identically either way.
   * The parts the walk draws beside these meshes (curves, point clouds,
   * by-parent meshes with transparency of their own) are charged one at a
   * time. So are the meshes of a placement the reach refuses, which is one
   * bound for the whole block and can refuse a placement whose every mesh
   * would fit; each is then looked at on its own, and one the range check
   * leaves out costs no triangles.
   *
   * One instance record places every mesh of its block, so a placement that
   * may push any of them out of range is baked too: both modes draw the same.
   * The block's reach decides that in one step, whatever the mesh count.
   */
  place(object: number, id: string, block: BlockMeshes, xform: Xform, color: RhinoRgba): boolean {
    if (block.meshes.length === 0) return true;
    if (this.exhausted) return false;
    const whole = keepsF32(xform, block.reach);
    if (this.bake || !whole) {
      // A whole block is admitted before any of its meshes is drawn; the per-mesh charges below
      // come to the same total, so none of them can refuse what this admitted.
      if (whole && !this.fits(block.cost)) return false;
      return block.meshes.every(mesh => this.draw(object, { kind: 'mesh', ...mesh }, xform, mesh.color ?? color));
    }
    if (!this.take(block.cost)) return false;
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
