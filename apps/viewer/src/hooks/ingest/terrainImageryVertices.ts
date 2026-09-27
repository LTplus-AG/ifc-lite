/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Carry a rendered LandXML terrain vertex back to its SOURCE plan position
 * (#5942, mapping spec §15.4).
 *
 * The drape's UVs are a function of the vertex's easting and northing in the
 * terrain's own CRS, not of where the viewer happens to draw it: federation
 * re-bakes a model into its anchor's frame, and the render frame subtracts an
 * origin shift. So the rendered position is taken through the pre-alignment
 * snapshot (when the model was aligned), the mesh origin and the frame shift
 * back to viewer-source metres — X east, Y up, Z south, as
 * `buildLandXmlSurfaceMesh` wrote it — and then SNAPPED to the surface's own
 * TIN point. The snap is both the exactness guarantee (the viewer and the
 * export compute UVs from the same authored numbers) and the proof that the
 * frame was recovered correctly: a vertex with no TIN point within tolerance
 * means the frame is not what this module assumes, and the drape is refused
 * rather than placed on a guess.
 */

import type { LandXmlTinSurface } from './landXmlSemantics.js';

/** The frame one rendered mesh's positions are expressed in. */
export interface TerrainMeshFrame {
  positions: Float32Array;
  origin: readonly [number, number, number] | undefined;
  originShift: { x: number; y: number; z: number };
}

export interface TerrainPlanScales {
  linearScaleToMeters: number;
  elevationScaleToMeters: number;
}

/** Recovered positions: per vertex `[easting, northing]`, in the terrain's native plan units. */
export type SourcePlanResult =
  | { ok: true; plan: Float64Array; pointIds: string[] }
  | { ok: false; reason: string };

/**
 * Snap tolerance, metres. A rendered vertex is an f32 residual against an f64
 * origin, so it is off its source point by at most ~|residual|·2⁻²⁴ — well
 * under a millimetre for any component the render frame admits.
 */
const SNAP_TOLERANCE_M = 0.01;

interface SourcePoint { id: string; northing: number; easting: number; elevation: number }

/** Uniform-grid index over a surface's source points, in metres. Nested
 *  numeric maps: survey coordinates overflow a single packed integer key. */
class PointGrid {
  private readonly cells = new Map<number, Map<number, SourcePoint[]>>();
  constructor(points: Iterable<SourcePoint>, private readonly scales: TerrainPlanScales, private readonly cell: number) {
    for (const point of points) {
      const cx = Math.floor((point.easting * scales.linearScaleToMeters) / cell);
      const cy = Math.floor((point.northing * scales.linearScaleToMeters) / cell);
      let column = this.cells.get(cx);
      if (!column) { column = new Map(); this.cells.set(cx, column); }
      const bucket = column.get(cy);
      if (bucket) bucket.push(point);
      else column.set(cy, [point]);
    }
  }
  /** Nearest source point to `(east, north, up)` metres within `tolerance`, in 3D. */
  nearest(east: number, north: number, up: number, tolerance: number): SourcePoint | null {
    const cx = Math.floor(east / this.cell);
    const cy = Math.floor(north / this.cell);
    let best: SourcePoint | null = null;
    let bestDistance = tolerance;
    for (let dx = -1; dx <= 1; dx += 1) {
      const column = this.cells.get(cx + dx);
      if (!column) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const point of column.get(cy + dy) ?? []) {
          const distance = Math.hypot(
            point.easting * this.scales.linearScaleToMeters - east,
            point.northing * this.scales.linearScaleToMeters - north,
            point.elevation * this.scales.elevationScaleToMeters - up,
          );
          if (distance <= bestDistance) { best = point; bestDistance = distance; }
        }
      }
    }
    return best;
  }
}

/**
 * A surface's source points, indexed once and shared by every rendered mesh
 * of that surface — the loader splits one surface into many components.
 */
export class SurfaceSnapper {
  private readonly grid: PointGrid;
  constructor(readonly surface: LandXmlTinSurface, readonly scales: TerrainPlanScales) {
    // Every authored position a rendered vertex can come from.
    this.grid = new PointGrid([...surface.points, ...(surface.canonicalVertices ?? [])], scales, SNAP_TOLERANCE_M * 4);
  }

  /**
   * Source plan positions for every vertex of one rendered terrain mesh.
   *
   * `frame` is the mesh as it stood in the model's own frame — the
   * pre-alignment snapshot when the model was federated, the live mesh
   * otherwise.
   */
  sourcePlanPositions(frame: TerrainMeshFrame): SourcePlanResult {
    const origin = frame.origin ?? [0, 0, 0];
    const count = frame.positions.length / 3;
    const plan = new Float64Array(count * 2);
    const pointIds: string[] = new Array(count);
    for (let vertex = 0; vertex < count; vertex += 1) {
      const east = frame.positions[vertex * 3] + origin[0] + frame.originShift.x;
      const up = frame.positions[vertex * 3 + 1] + origin[1] + frame.originShift.y;
      const north = -(frame.positions[vertex * 3 + 2] + origin[2] + frame.originShift.z);
      const point = this.grid.nearest(east, north, up, SNAP_TOLERANCE_M);
      if (!point) {
        return {
          ok: false,
          reason: `A rendered vertex of surface '${this.surface.name}' matches no TIN point of that surface within `
            + `${SNAP_TOLERANCE_M * 100} cm, so the terrain's source frame cannot be recovered to place the image on it.`,
        };
      }
      plan[vertex * 2] = point.easting;
      plan[vertex * 2 + 1] = point.northing;
      pointIds[vertex] = point.id;
    }
    return { ok: true, plan, pointIds };
  }
}
