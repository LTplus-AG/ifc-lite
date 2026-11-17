/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World frames of `IfcLocalPlacement` chains, in the file's raw length unit,
 * with no meshing. The chain walk is the shared guarded
 * {@link walkPlacementChain} (visited set, no depth cap); a cycle or a
 * placement kind this resolver does not handle (grid, linear) yields null so
 * the caller can report the element as unplaced instead of guessing.
 */

import { firstProjAxis, walkPlacementChain } from '@ifc-lite/data';
import { asNumber, asRef, type ModelReader } from './reader.js';

export type Vec3 = [number, number, number];

/** A rigid frame: origin plus orthonormal axes, in the parent's coordinates. */
export interface Frame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export const IDENTITY: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export function normalize(v: Vec3): Vec3 | null {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Apply `f` to a point given in `f`'s own coordinates. */
export function applyFrame(f: Frame, p: Vec3): Vec3 {
  return [
    f.origin[0] + f.x[0] * p[0] + f.y[0] * p[1] + f.z[0] * p[2],
    f.origin[1] + f.x[1] * p[0] + f.y[1] * p[1] + f.z[1] * p[2],
    f.origin[2] + f.x[2] * p[0] + f.y[2] * p[1] + f.z[2] * p[2],
  ];
}

function applyDirection(f: Frame, d: Vec3): Vec3 {
  return [
    f.x[0] * d[0] + f.y[0] * d[1] + f.z[0] * d[2],
    f.x[1] * d[0] + f.y[1] * d[1] + f.z[1] * d[2],
    f.x[2] * d[0] + f.y[2] * d[1] + f.z[2] * d[2],
  ];
}

/** `outer ∘ inner`: a frame given in `outer`'s coordinates, expressed in `outer`'s parent. */
export function composeFrames(outer: Frame, inner: Frame): Frame {
  return {
    origin: applyFrame(outer, inner.origin),
    x: applyDirection(outer, inner.x),
    y: applyDirection(outer, inner.y),
    z: applyDirection(outer, inner.z),
  };
}

export function readPoint(reader: ModelReader, id: unknown): Vec3 | null {
  const e = reader.entity(asRef(id));
  if (!e || e.type !== 'IFCCARTESIANPOINT') return null;
  const coords = e.attributes[0];
  if (!Array.isArray(coords)) return null;
  const c = coords.map(asNumber);
  if (c.length < 2 || c.some((v) => v === null)) return null;
  return [c[0] as number, c[1] as number, (c[2] as number | undefined) ?? 0];
}

export function readDirection(reader: ModelReader, id: unknown): Vec3 | null {
  const e = reader.entity(asRef(id));
  if (!e || e.type !== 'IFCDIRECTION') return null;
  const ratios = e.attributes[0];
  if (!Array.isArray(ratios)) return null;
  const r = ratios.map(asNumber);
  if (r.length < 2 || r.some((v) => v === null)) return null;
  return normalize([r[0] as number, r[1] as number, (r[2] as number | undefined) ?? 0]);
}

/** An `IfcAxis2Placement3D`/`2D` as a frame in its parent's coordinates; null when unreadable. */
export function axisPlacementFrame(reader: ModelReader, id: unknown): Frame | null {
  const e = reader.entity(asRef(id));
  if (!e) return null;
  const origin = readPoint(reader, e.attributes[0]);
  if (!origin) return null;
  if (e.type === 'IFCAXIS2PLACEMENT2D') {
    const ref = e.attributes[1] == null ? [1, 0, 0] as Vec3 : readDirection(reader, e.attributes[1]);
    if (!ref) return null;
    const x = normalize([ref[0], ref[1], 0]);
    if (!x) return null;
    return { origin, x, y: [-x[1], x[0], 0], z: [0, 0, 1] };
  }
  if (e.type !== 'IFCAXIS2PLACEMENT3D') return null;
  const z = e.attributes[1] == null ? [0, 0, 1] as Vec3 : readDirection(reader, e.attributes[1]);
  const refDir = e.attributes[2] == null ? null : readDirection(reader, e.attributes[2]);
  if (!z) return null;
  // IFC's BuildAxes: X is RefDirection made perpendicular to Z; without one, the shared FirstProjAxis.
  const guess: Vec3 = refDir ?? firstProjAxis(z);
  const d = dot(guess, z);
  const x = normalize([guess[0] - d * z[0], guess[1] - d * z[1], guess[2] - d * z[2]]);
  if (!x) return null;
  return { origin, x, y: cross(z, x), z };
}

/** Resolves and caches world frames of `IfcLocalPlacement` entities. */
export class PlacementResolver {
  private readonly cache = new Map<number, Frame | null>();

  constructor(private readonly reader: ModelReader) {}

  /** World frame of an `IfcLocalPlacement`, raw file units; null for cycles, grid/linear placements or broken links. */
  world(placementId: number | null): Frame | null {
    if (placementId === null) return null;
    const known = this.cache.get(placementId);
    if (known !== undefined) return known;
    const chain = walkPlacementChain(
      placementId,
      (id) => {
        const e = this.reader.entity(id);
        return e?.type === 'IFCLOCALPLACEMENT' ? asRef(e.attributes[0]) : null;
      },
      { stopAt: (id) => id !== placementId && this.cache.has(id) },
    );
    if (chain.end === 'cycle') {
      for (const id of chain.ids) this.cache.set(id, null);
      return null;
    }
    const ids = chain.ids;
    const last = ids[ids.length - 1];
    let frame: Frame | null;
    let from: number;
    if (chain.end === 'stopped') {
      frame = this.cache.get(last) ?? null;
      from = ids.length - 2;
    } else {
      frame = IDENTITY;
      from = ids.length - 1;
    }
    for (let i = from; i >= 0; i--) {
      if (frame === null) {
        this.cache.set(ids[i], null);
        continue;
      }
      const e = this.reader.entity(ids[i]);
      const local = e?.type === 'IFCLOCALPLACEMENT' ? axisPlacementFrame(this.reader, e.attributes[1]) : null;
      frame = local ? composeFrames(frame, local) : null;
      this.cache.set(ids[i], frame);
    }
    return this.cache.get(placementId) ?? null;
  }

  /** World frame of a product's `ObjectPlacement`. */
  ofProduct(productId: number): Frame | null {
    const product = this.reader.entity(productId);
    return this.world(asRef(this.reader.attr(product, 'ObjectPlacement')));
  }
}
