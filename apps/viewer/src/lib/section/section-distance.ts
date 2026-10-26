/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section bar's distance arithmetic (#5499, charter #5478 §6).
 *
 * The store keeps a cardinal cut as a PERCENTAGE of the model bounds along
 * its axis (`SectionPlane.position`; 0..100 spans the bounds, and any finite
 * value outside it is a cut beyond them, #8162), which is what every reader
 * (renderer, drawing generation, BCF, export) resolves against the merged
 * `shiftedBounds`. The bar shows the same cut in world METRES — "+1.20 m",
 * not "37.5 %" — because a distance is what a user reasons about, and a
 * storey elevation is a distance. These helpers are the one place the two
 * are converted, against the same bounds `useFederatedGeometry` hands the
 * renderer (the union of every VISIBLE model's `shiftedBounds`; a single
 * model's own box when there is one).
 *
 * Storeys are collected here too (shared with the floor-plan command,
 * `useFloorplanView`), because a storey is the bar's snap target: a plan cut
 * sits `PLAN_CUT_HEIGHT_M` above its floor, the same architectural
 * convention the floor plan applies.
 */

import type { GeometryResult } from '@ifc-lite/geometry';
import type { SectionPlaneAxis } from '@/store/types';

interface Vec3Like { x: number; y: number; z: number }
export interface AxisBounds { min: Vec3Like; max: Vec3Like }
export interface AxisRange { min: number; max: number }

/** A model entry's slice that the distance math reads. */
interface BoundedModel {
  visible: boolean;
  geometryResult: Pick<GeometryResult, 'coordinateInfo'> | null;
}

/** A model entry's slice that storey collection reads. */
interface StoreyModel {
  ifcDataStore: {
    spatialHierarchy?: {
      byStorey: ReadonlyMap<number, unknown>;
      storeyElevations: ReadonlyMap<number, number>;
    } | null;
    entities: { getName(id: number): string | null };
  } | null;
}

export interface SectionStorey {
  expressId: number;
  modelId: string;
  name: string;
  /** Floor elevation, metres, in the model's (Z-up) frame. */
  elevation: number;
}

/** Height of a plan cut above its storey's floor (the architectural convention). */
export const PLAN_CUT_HEIGHT_M = 1.2;

/** Viewer is Y-up: `down` cuts along viewer Y (IFC Z), `front` along viewer Z (IFC Y), `side` along X. */
export function sectionAxisKey(axis: SectionPlaneAxis): 'x' | 'y' | 'z' {
  return axis === 'side' ? 'x' : axis === 'down' ? 'y' : 'z';
}

function isUsable(b: AxisBounds | undefined): b is AxisBounds {
  return !!b && (b.max.x > b.min.x || b.max.y > b.min.y || b.max.z > b.min.z);
}

/**
 * The bounds the renderer cuts against: the union of every visible model's
 * `shiftedBounds` (mirrors `useFederatedGeometry`'s merge), or the legacy
 * single-model result's box. `null` while nothing usable has loaded.
 */
export function mergedSectionBounds(
  models: ReadonlyMap<string, BoundedModel>,
  legacy: Pick<GeometryResult, 'coordinateInfo'> | null,
): AxisBounds | null {
  let acc: AxisBounds | null = null;
  const fold = (b: AxisBounds | undefined) => {
    if (!isUsable(b)) return;
    acc = acc
      ? {
          min: { x: Math.min(acc.min.x, b.min.x), y: Math.min(acc.min.y, b.min.y), z: Math.min(acc.min.z, b.min.z) },
          max: { x: Math.max(acc.max.x, b.max.x), y: Math.max(acc.max.y, b.max.y), z: Math.max(acc.max.z, b.max.z) },
        }
      : { min: { ...b.min }, max: { ...b.max } };
  };
  if (models.size > 0) {
    for (const model of models.values()) {
      if (model.visible) fold(model.geometryResult?.coordinateInfo?.shiftedBounds);
    }
  } else {
    fold(legacy?.coordinateInfo?.shiftedBounds);
  }
  return acc;
}

/** The world-unit span of `bounds` along a cut axis, or `null` when degenerate. */
export function sectionAxisRange(bounds: AxisBounds | null, axis: SectionPlaneAxis): AxisRange | null {
  if (!bounds) return null;
  const key = sectionAxisKey(axis);
  const min = bounds.min[key];
  const max = bounds.max[key];
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null;
}

/** `position` (a percentage of `range`; outside 0..100 is beyond it) as a world coordinate along the axis. */
export function percentToWorld(position: number, range: AxisRange): number {
  return range.min + (position / 100) * (range.max - range.min);
}

/**
 * A world coordinate along the axis as an UNCLAMPED `position`: the exact
 * inverse of {@link percentToWorld}, so a cut above the model top reads
 * above 100 (#8162). The store accepts any finite position.
 */
export function worldToPosition(world: number, range: AxisRange): number {
  return ((world - range.min) / (range.max - range.min)) * 100;
}

/**
 * A percentage held to the bounded 0..100 contract of the percent control and
 * the SDK / embed section commands. A non-finite input keeps the coercion
 * those inputs always had (`NaN` and `-Infinity` read 0, `Infinity` reads 100).
 */
export function clampSectionPercent(position: number): number {
  return Math.min(100, Math.max(0, Number(position) || 0));
}

/** A world coordinate along the axis as the clamped 0..100 `position` (the distance control's variant). */
export function worldToPercent(world: number, range: AxisRange): number {
  return clampSectionPercent(worldToPosition(world, range));
}

/**
 * Every storey across the loaded models, deduplicated at 0.5 m (federated
 * models repeat the same levels; the shortest name wins a tie) and sorted
 * top-down, the order a storey list reads in.
 */
export function collectStoreys(
  models: ReadonlyMap<string, StoreyModel>,
  legacy: StoreyModel['ifcDataStore'],
): SectionStorey[] {
  const storeys: SectionStorey[] = [];
  const collect = (modelId: string, ds: StoreyModel['ifcDataStore']) => {
    if (!ds?.spatialHierarchy) return;
    const { byStorey, storeyElevations } = ds.spatialHierarchy;
    for (const storeyId of byStorey.keys()) {
      const elevation = storeyElevations.get(storeyId) ?? 0;
      const name = ds.entities.getName(storeyId) || `Storey #${storeyId}`;
      storeys.push({ expressId: storeyId, modelId, name, elevation });
    }
  };
  if (models.size > 0) {
    for (const [modelId, model] of models) collect(modelId, model.ifcDataStore);
  } else {
    collect('legacy', legacy);
  }
  const seen = new Map<string, SectionStorey>();
  for (const s of storeys) {
    const key = (Math.round(s.elevation * 2) / 2).toFixed(2);
    const prior = seen.get(key);
    if (!prior || s.name.length < prior.name.length) seen.set(key, s);
  }
  return Array.from(seen.values()).sort((a, b) => b.elevation - a.elevation);
}

/** Where a plan cut through `storey` sits: its floor plus the plan-cut height. */
export function storeyCutElevation(storey: Pick<SectionStorey, 'elevation'>): number {
  return storey.elevation + PLAN_CUT_HEIGHT_M;
}

/**
 * How far (metres) a storey's floor may sit outside the cut range and still
 * count as inside it. Storey elevations are nominal authored values, while
 * the range comes from f32 mesh positions, so a floor that coincides with the
 * model's lowest or highest face can read a fraction of a millimetre outside.
 * 1 mm covers that rounding and no more, so a frame mismatch between raw
 * elevations and shifted / placed bounds that puts the floor outside the
 * range still takes the clamped fallback.
 */
export const STOREY_IN_RANGE_TOLERANCE_M = 1e-3;

/**
 * The store `position` of a plan cut through `storey` (#8162): its floor plus
 * `PLAN_CUT_HEIGHT_M`, resolved against `range`.
 *
 * When the floor itself lies within the range (within
 * `STOREY_IN_RANGE_TOLERANCE_M`), the cut may extrapolate past the bounds, so
 * a top storey whose floor + 1.2 m clears the model top keeps its real cut
 * height instead of landing on the top face. Otherwise the result is clamped
 * to 0..100 as before: storey elevations are raw model-frame values and the
 * range is in the shifted / placed render frame, so a floor outside the range
 * may mean the two frames disagree, and extrapolating through that mismatch
 * would move the cut further from where it belongs.
 */
export function storeyCutPosition(storey: Pick<SectionStorey, 'elevation'>, range: AxisRange): number {
  const floor = storey.elevation;
  const cut = storeyCutElevation(storey);
  const inRange = floor >= range.min - STOREY_IN_RANGE_TOLERANCE_M && floor <= range.max + STOREY_IN_RANGE_TOLERANCE_M;
  return inRange ? worldToPosition(cut, range) : worldToPercent(cut, range);
}

/**
 * The store `position` for a saved world-space cut coordinate restored
 * against `[axisMin, axisMax]` (a persisted drawing's `SectionConfig`). A
 * cut outside the bounds stays outside (#8162); a degenerate span or a
 * non-finite result falls back to the centre, 50.
 */
export function restoredCutPosition(world: number, axisMin: number, axisMax: number): number {
  if (!(axisMax - axisMin > 1e-9)) return 50;
  const position = worldToPosition(world, { min: axisMin, max: axisMax });
  return Number.isFinite(position) ? position : 50;
}
