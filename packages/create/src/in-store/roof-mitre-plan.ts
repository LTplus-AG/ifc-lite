/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Continuous parallel roof tops, partitioned by signed-distance bisectors. */
import { heightAt, type FootprintRoofPlan } from './roof-footprint-plan.js';
import { cellPlaneArea, cellVolume, centre, clipCell, dot3, normaliseCut, slabCell, splitPolygon, subtract3, triangles,
  type Cut, type Point, type Polyhedron } from './roof-mitre-polyhedron.js';

export interface MitredPlane {
  /** Disjoint clipping regions of the plane's full eaves-wide slab. */
  readonly regions: Cut[][];
  /** Exact polyhedral volume, in the plan's native length unit cubed. */
  readonly volume: number;
  readonly area: number;
}

/** A max-of-min affine expression for the underside terrain. Splitting each
 * original face by h_i == h_j makes every comparison with its own h_i constant.
 * The validation below therefore proves equality on whole cells, not samples
 * of an unchecked approximation. Replacing each h_j by h_j + T/cos(j) then
 * gives a continuous parallel top, including at valleys and topology changes. */
function terrainTerms(plan: FootprintRoofPlan, tolerance: number): number[][] {
  const heights = plan.planes.map(plane => (p: [number, number]) => heightAt(plane, p));
  const cells: Array<{ face: number; polygon: [number, number][]; sample: [number, number] }> = [];
  const terms = new Map<string, number[]>();
  for (let i = 0; i < plan.planes.length; i++) {
    let pieces = triangles(plan.planes[i].outline);
    for (let j = 0; j < heights.length; j++) if (i !== j) {
      pieces = pieces.flatMap(p => splitPolygon(p, v => heights[j](v) - heights[i](v), tolerance));
    }
    for (const polygon of pieces) {
      const sample: [number, number] = [0, 1].map(axis => polygon.reduce((s, p) => s + p[axis], 0) / polygon.length) as [number, number];
      const h = heights[i](sample);
      const term = heights.flatMap((height, j) => height(sample) >= h - tolerance ? [j] : []);
      terms.set(term.join(','), term); cells.push({ face: i, polygon, sample });
    }
  }
  const all = [...terms.values()];
  // In max(min(S)), a proper superset of another term cannot contribute.
  const minimal = all.filter(term => !all.some(other => other.length < term.length && other.every(j => term.includes(j))));
  for (const cell of cells) for (const p of [...cell.polygon, cell.sample]) {
    const actual = Math.max(...minimal.map(term => Math.min(...term.map(j => heights[j](p)))));
    if (Math.abs(actual - heights[cell.face](p)) > tolerance * 20) {
      throw new Error('The roof terrain cannot be represented by its validated plane arrangement');
    }
  }
  return minimal;
}

/** The two roof skins are F=0 and F=T, where F is a min-of-max signed-distance
 * expression. Their common face is d_i=d_j; it is vertical only for equal
 * pitches. Partitioning by those planes avoids both overlaps and open steps. */
export function planRoofMitres(plan: FootprintRoofPlan, thickness: number): MitredPlane[] | null {
  if (plan.planes.length < 2 || plan.planes.every(p => Math.abs(p.slope - plan.planes[0].slope) < 1e-12)) return null;
  const size = Math.max(...plan.eaves.map(p => Math.hypot(p[0] - plan.eaves[0][0], p[1] - plan.eaves[0][1])), thickness);
  const tolerance = size * 1e-10, volumeTolerance = size ** 2 * thickness * 1e-12;
  const terms = terrainTerms(plan, tolerance);
  const surfaces = plan.planes.map(plane => {
    const sin = Math.sin(plane.slope), cos = Math.cos(plane.slope);
    const n: Point = [plane.direction[1] * sin, -plane.direction[0] * sin, cos];
    return { n, k: n[0] * plane.origin[0] + n[1] * plane.origin[1] };
  });
  const distance = (i: number, p: Point) => dot3(surfaces[i].n, p) - surfaces[i].k;
  const eaves = triangles(plan.eaves);
  const seeds = plan.planes.map(plane => centre(plane.outline.map(([x, y]): Point => [x, y, 0])));
  return plan.planes.map((plane, i) => {
    const normal = surfaces[i], cuts: Cut[] = [], ownership: Cut[] = [];
    for (let j = 0; j < surfaces.length; j++) if (i !== j) {
      const n = subtract3(normal.n, surfaces[j].n), k = normal.k - surfaces[j].k;
      if (Math.hypot(...n) > 1e-12) cuts.push(normaliseCut(n, k));
      else if (Math.abs(k) <= tolerance) {
        // Coincident patches have no physical crease. A vertical partition
        // retains distinct edge/style identities without duplicating material.
        const d = subtract3(seeds[i], seeds[j]);
        ownership.push(normaliseCut(d, (dot3(seeds[i], seeds[i]) - dot3(seeds[j], seeds[j])) / 2));
      }
    }
    type Cell = { solid: Polyhedron; signs: number[] };
    const patterns = new Map<string, { cuts: Cut[]; volume: number; area: number }>();
    for (const triangle of eaves) {
      let base = slabCell(triangle, p => heightAt(plane, p), thickness / Math.cos(plane.slope));
      for (const cut of ownership) base = clipCell(base, cut, tolerance);
      if (!base.length) continue;
      let cells: Cell[] = [{ solid: base, signs: [] }];
      for (const cut of cuts) {
        const opposite = { n: cut.n.map(v => -v) as Point, k: -cut.k };
        cells = cells.flatMap(cell => [1, -1].flatMap(sign => {
          const solid = clipCell(cell.solid, sign === 1 ? cut : opposite, tolerance);
          return solid.length && cellVolume(solid) > volumeTolerance ? [{ solid, signs: [...cell.signs, sign] }] : [];
        }));
      }
      for (const cell of cells) {
        const p = centre(cell.solid.flat()), own = distance(i, p);
        const value = Math.min(...terms.map(term => Math.max(...term.map(j => distance(j, p)))));
        if (Math.abs(value - own) > tolerance * 20) continue;
        const key = cell.signs.join(',');
        const previous = patterns.get(key);
        const area = cellPlaneArea(cell.solid, normal.n, normal.k, tolerance * 20);
        if (previous) { previous.volume += cellVolume(cell.solid); previous.area += area; }
        else patterns.set(key, { cuts: [...ownership, ...cuts.map((cut, j) => ({
          n: cut.n.map(v => v * cell.signs[j]) as Point, k: cut.k * cell.signs[j],
        }))], volume: cellVolume(cell.solid), area });
      }
    }
    const regions = [...patterns.values()];
    if (!regions.length) throw new Error(`Mitred roof plane ${plane.edge} has no material`);
    return { regions: regions.map(p => p.cuts), volume: regions.reduce((sum, p) => sum + p.volume, 0), area: regions.reduce((sum, p) => sum + p.area, 0) };
  });
}
