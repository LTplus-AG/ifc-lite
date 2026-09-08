/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tessellation-invariant shape signature `findDuplicates` labels severity
 * with: total surface area + enclosed volume of an element's world-space
 * triangle soup, and the 5% agreement rule over the pair. Split out of
 * `duplicates.ts` (which owns the pass itself) to keep both under the
 * ~400-line module limit; not part of the public package surface.
 */

import type { ClashElement } from './types.js';

/**
 * How far apart (relative) two elements' surface areas / enclosed volumes may be
 * and still count as the same shape. 5% is chosen from the two failure modes it
 * has to separate, both measured on the fixtures in `duplicates.test.ts`:
 * - **Same solid, re-tessellated.** A flat-faced solid — the box that started
 *   this — is *exactly* invariant: a 12- and a 48-triangle 1×1×3 box both give
 *   area 14 and volume 3. A faceted curved solid is not, because each
 *   refinement encloses more: a 12- vs a 36-segment column differs by 4.0% in
 *   volume. 5% keeps that pair together.
 * - **Different solids sharing a bounding box.** A round column and a square
 *   column of the same bounds differ by 22.7% in area and 25.0% in volume —
 *   ~5× the tolerance.
 * Below ~8 segments the two modes genuinely overlap (an 8- vs 36-segment
 * column is 9.5% apart) and no threshold separates them; such a pair reads as
 * `minor`, which is the safe direction: it is still reported, just not labelled
 * exact.
 */
const SHAPE_REL_TOL = 0.05;

/** Total surface area (m²) and enclosed volume (m³) of one element's mesh. */
export interface ShapeSignature {
  area: number;
  volume: number;
}

/**
 * A tessellation-invariant fingerprint of an element's world-space triangle
 * soup. Both numbers are integrals over the *surface*, so re-triangulating the
 * same surface leaves them unchanged — which the triangle count this replaced
 * did not: a 12- and a 48-triangle box are the same object and read as
 * different, while a round and a square column of equal bounds can share a
 * count and read as the same.
 *
 * Volume is `|Σ v0 · (v1 × v2)| / 6` (the divergence theorem). It is exact for
 * a closed, consistently wound mesh and 0 for a flat sheet; an inconsistently
 * wound mesh yields some other tessellation-dependent number — usually pushing
 * the pair towards `minor`, but with no guarantee: two different open meshes
 * whose volume terms both cancel to ~0 are decided on area alone, and the
 * absolute value deliberately equates opposite windings, so a wholly reversed
 * mesh — the same solid, wound inward — matches the mesh it copies. Area is
 * invariant regardless of winding, so the pair of numbers degrades to an
 * area-only comparison rather than to noise.
 *
 * O(triangles), and computed at most once per element (see `signatureOf` in
 * `duplicates.ts`), only for elements that already reached the exact-duplicate
 * gate — so a model with no coincident pairs pays nothing for it.
 */
export function shapeSignature(el: ClashElement): ShapeSignature {
  const { positions, indices } = el;
  const m = el.transform;
  const vertexCount = Math.floor(positions.length / 3);
  const triangles = Math.floor(indices.length / 3);
  // Three world-space vertices, held flat to keep the loop allocation-free.
  const v = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let area = 0;
  let volume = 0;
  for (let t = 0; t < triangles; t += 1) {
    let ok = true;
    for (let k = 0; k < 3; k += 1) {
      const vi = indices[t * 3 + k];
      if (vi >= vertexCount) {
        // An out-of-range index has no position to read; skipping the triangle
        // keeps the signature finite instead of poisoning it with NaN.
        ok = false;
        break;
      }
      const o = vi * 3;
      const x = positions[o];
      const y = positions[o + 1];
      const z = positions[o + 2];
      if (m) {
        // f32-round the transformed coords exactly as `TriMesh.vertex` does, so
        // a signature never disagrees with the narrow phase about where a
        // vertex is.
        v[k * 3] = Math.fround(m[0] * x + m[4] * y + m[8] * z + m[12]);
        v[k * 3 + 1] = Math.fround(m[1] * x + m[5] * y + m[9] * z + m[13]);
        v[k * 3 + 2] = Math.fround(m[2] * x + m[6] * y + m[10] * z + m[14]);
      } else {
        v[k * 3] = x;
        v[k * 3 + 1] = y;
        v[k * 3 + 2] = z;
      }
    }
    if (!ok) continue;
    const e1x = v[3] - v[0];
    const e1y = v[4] - v[1];
    const e1z = v[5] - v[2];
    const e2x = v[6] - v[0];
    const e2y = v[7] - v[1];
    const e2z = v[8] - v[2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    volume += (v[0] * (v[4] * v[8] - v[5] * v[7])
      - v[1] * (v[3] * v[8] - v[5] * v[6])
      + v[2] * (v[3] * v[7] - v[4] * v[6])) / 6;
  }
  return { area, volume: Math.abs(volume) };
}

/** Relative agreement, with 0 vs 0 counting as agreement (a flat sheet has no
 *  volume, so such a pair is decided on area alone). */
function relClose(x: number, y: number): boolean {
  const scale = Math.max(Math.abs(x), Math.abs(y));
  return Math.abs(x - y) <= SHAPE_REL_TOL * scale;
}

/** Do the two meshes describe the same solid? An element with no measurable
 *  surface (no triangles, or geometry the caller did not supply) carries no
 *  evidence either way, so it is never promoted to "exact". */
export function sameShape(a: ShapeSignature, b: ShapeSignature): boolean {
  if (a.area <= 0 || b.area <= 0) return false;
  return relClose(a.area, b.area) && relClose(a.volume, b.volume);
}
