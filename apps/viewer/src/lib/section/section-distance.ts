/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section bar's distance arithmetic (#5499, charter #5478 §6).
 *
 * The store keeps a cardinal cut as a PERCENTAGE of the model bounds along
 * its axis (`SectionPlane.position`, 0..100), which is what every reader
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

/** `position` (0..100 of `range`) as a world coordinate along the axis. */
export function percentToWorld(position: number, range: AxisRange): number {
  return range.min + (position / 100) * (range.max - range.min);
}

/** A world coordinate along the axis as the clamped 0..100 `position`. */
export function worldToPercent(world: number, range: AxisRange): number {
  const pct = ((world - range.min) / (range.max - range.min)) * 100;
  return Math.min(100, Math.max(0, pct));
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
