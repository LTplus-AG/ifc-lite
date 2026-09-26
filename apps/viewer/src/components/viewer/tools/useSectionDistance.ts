/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section bar's distance field, as a value the store can hold (#5499).
 *
 * Three shapes, one control:
 *  - a face-picked plane's signed `custom.distance` (metres along its normal);
 *  - a cardinal cut as a world coordinate in metres along its axis, converted
 *    to and from the store's 0..100 `position` against the bounds the
 *    renderer cuts against (`mergedSectionBounds`, then the same placement
 *    adjustment `usePlacementCoordinateInfo` applies for the viewport);
 *  - the raw percentage while no usable bounds exist yet (nothing loaded).
 *
 * A `down` cut also carries the storeys as scrub snaps: a plan cut through a
 * storey sits `PLAN_CUT_HEIGHT_M` above its floor, the floor-plan convention.
 */

import { useCallback, useMemo } from 'react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { usePlacementCoordinateInfo } from '@/hooks/usePlacementCoordinateInfo';
import {
  collectStoreys,
  mergedSectionBounds,
  percentToWorld,
  sectionAxisRange,
  storeyCutElevation,
  worldToPercent,
  type AxisBounds,
  type AxisRange,
  type SectionStorey,
} from '@/lib/section/section-distance';

/** Scrub catchment around a storey's cut elevation, metres. */
export const STOREY_SNAP_TOLERANCE_M = 0.15;

export interface SectionDistance {
  /** `'custom'` = along the picked normal; `'world'` = along the cardinal axis; `'percent'` = no bounds yet. */
  kind: 'custom' | 'world' | 'percent';
  value: number;
  onChange: (next: number) => void;
  step: number;
  min: number;
  max: number;
  /** Storey cut elevations a scrub snaps to (a `down` cut with a known range only). */
  snaps: readonly number[];
  /** Every storey, top-down; the storey menu lists these. */
  storeys: readonly SectionStorey[];
  /** The cardinal range in world units, when known. */
  range: AxisRange | null;
  /** The placed model bounds the cut resolves against, when known — the section box's "fit to model" (#5513). */
  bounds: AxisBounds | null;
  /** Cut through `storey` (a plan cut, `down` axis). */
  cutAtStorey: (storey: SectionStorey) => void;
}

export function useSectionDistance(): SectionDistance {
  const models = useViewerStore((s) => s.models);
  const geometryResult = useViewerStore((s) => s.geometryResult);
  const ifcDataStore = useViewerStore((s) => s.ifcDataStore);
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const setSectionPlaneAxis = useViewerStore((s) => s.setSectionPlaneAxis);
  const setSectionPlanePosition = useViewerStore((s) => s.setSectionPlanePosition);
  const setSectionCustomDistance = useViewerStore((s) => s.setSectionCustomDistance);

  // The merged box as a CoordinateInfo, so the placement hook can shift it
  // the way it shifts the viewport's; frame metadata comes from whichever
  // model contributed first (federated models share one frame).
  const source = useMemo((): CoordinateInfo | undefined => {
    const bounds = mergedSectionBounds(models, geometryResult);
    if (!bounds) return undefined;
    let base: CoordinateInfo | undefined;
    for (const model of models.values()) {
      if (model.visible && model.geometryResult?.coordinateInfo) { base = model.geometryResult.coordinateInfo; break; }
    }
    base ??= geometryResult?.coordinateInfo;
    return base ? { ...base, shiftedBounds: bounds } : undefined;
  }, [models, geometryResult]);
  const placed = usePlacementCoordinateInfo(source);
  const range = useMemo(
    () => sectionAxisRange(placed?.shiftedBounds ?? null, sectionPlane.axis),
    [placed, sectionPlane.axis],
  );
  const storeys = useMemo(() => collectStoreys(models, ifcDataStore), [models, ifcDataStore]);

  const cutAtStorey = useCallback((storey: SectionStorey) => {
    const state = useViewerStore.getState();
    if (state.sectionPlane.custom || state.sectionPlane.axis !== 'down') setSectionPlaneAxis('down');
    const r = sectionAxisRange(placed?.shiftedBounds ?? null, 'down');
    if (r) setSectionPlanePosition(worldToPercent(storeyCutElevation(storey), r));
  }, [placed, setSectionPlaneAxis, setSectionPlanePosition]);

  const bounds = placed?.shiftedBounds ?? null;
  const custom = sectionPlane.custom;
  const onChangeWorld = useCallback((next: number) => {
    if (range) setSectionPlanePosition(worldToPercent(next, range));
  }, [range, setSectionPlanePosition]);

  if (custom) {
    return {
      kind: 'custom', value: custom.distance, onChange: setSectionCustomDistance,
      step: 0.05, min: -Infinity, max: Infinity, snaps: [], storeys, range, bounds, cutAtStorey,
    };
  }
  if (range) {
    return {
      kind: 'world', value: percentToWorld(sectionPlane.position, range), onChange: onChangeWorld,
      step: 0.1, min: range.min, max: range.max,
      snaps: sectionPlane.axis === 'down' ? storeys.map(storeyCutElevation) : [],
      storeys, range, bounds, cutAtStorey,
    };
  }
  return {
    kind: 'percent', value: sectionPlane.position, onChange: setSectionPlanePosition,
    step: 1, min: 0, max: 100, snaps: [], storeys, range, bounds, cutAtStorey,
  };
}
