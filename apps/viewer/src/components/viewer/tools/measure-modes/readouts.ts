/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure readout helpers shared by the Measure bar's hint line and the
 * Measurements panel's list (#5502). Every function here derives its text
 * on render and stores nothing, so a correction to the maths retroactively
 * fixes every measurement already listed — the same discipline the angle
 * and radius modes shipped with (#2735, #2737).
 */

import type { TranslationKey } from '@/i18n/en';
import {
  ANGLE_REQUIRED_PICKS,
  type ActiveAngle,
  type ActiveMeasurement,
  type ActivePolyline,
  type ActiveRadius,
  type AngleKind,
  type AngleMeasurement,
  type MeasureMode,
} from '@/store/types';
import { formatDistance } from '../formatDistance';
import { formatThreePointAngle, threePointAngle } from './three-point-angle';
import { edgePairAngle, facePairAngle, formatAnglePair } from './edge-face-angle';
import { fitRadius, formatRadius, type Point3 as RadiusPoint3 } from './radius';

export { ANGLE_REQUIRED_PICKS };

/** The three angle kinds in UI order, with their label and hint keys. */
export const ANGLE_KIND_LABELS: ReadonlyArray<readonly [AngleKind, TranslationKey, TranslationKey]> = [
  ['points', 'measure.angleKind.points.label', 'measure.angleKind.points.hint'],
  ['edges', 'measure.angleKind.edges.label', 'measure.angleKind.edges.hint'],
  ['faces', 'measure.angleKind.faces.label', 'measure.angleKind.faces.hint'],
];

/** The four measure modes in UI order, with their label keys. */
export const MEASURE_MODE_LABELS: ReadonlyArray<readonly [MeasureMode, TranslationKey]> = [
  ['drag', 'measure.mode.distance'],
  ['polyline', 'measure.mode.polyline'],
  ['angle', 'measure.mode.angle'],
  ['radius', 'measure.mode.radius'],
];

/**
 * What to click next, per angle kind and per pick already placed. One
 * function rather than inline ternaries because the three kinds need
 * DIFFERENT counts and different words: a single "n/3 picks" wording once
 * read "3/3" for an edge pair with a fourth pick still required.
 */
export function angleHintKey(kind: AngleKind, placed: number): TranslationKey {
  if (kind === 'faces') {
    return placed === 0 ? 'measure.hint.faces.first' : 'measure.hint.faces.second';
  }
  if (kind === 'edges') {
    if (placed === 0) return 'measure.hint.edges.firstStart';
    if (placed === 1) return 'measure.hint.edges.firstEnd';
    if (placed === 2) return 'measure.hint.edges.secondStart';
    return 'measure.hint.edges.secondEnd';
  }
  if (placed === 0) return 'measure.hint.points.apex';
  return placed === 1 ? 'measure.hint.points.first' : 'measure.hint.points.second';
}

export interface MeasureHintState {
  measureMode: MeasureMode;
  angleKind: AngleKind;
  activeAngle: ActiveAngle | null;
  activePolyline: ActivePolyline | null;
  activeRadius: ActiveRadius | null;
  activeMeasurement: ActiveMeasurement | null;
}

/**
 * The one hint line for the HUD's bottom-center region. In angle and radius
 * modes `activeMeasurement` is always null (the drag gate refuses to start
 * one), so those branches name the gesture that actually works instead of
 * falling through to "Drag to measure".
 */
export function measureHintKey(s: MeasureHintState): TranslationKey {
  switch (s.measureMode) {
    case 'polyline':
      return s.activePolyline ? 'measure.hint.polylineActive' : 'measure.hint.polylineStart';
    case 'angle':
      return angleHintKey(s.angleKind, s.activeAngle?.picks.length ?? 0);
    case 'radius':
      return s.activeRadius ? 'measure.hint.radiusActive' : 'measure.hint.radiusStart';
    case 'drag':
      return s.activeMeasurement ? 'measure.hint.dragActive' : 'measure.hint.dragStart';
  }
}

/**
 * Readout for a stored angle. Switches on `kind` rather than pick COUNT:
 * edges take four picks and a future kind could collide on count, and the
 * kind is the thing that is actually true.
 */
export function formatAngleMeasurement(a: AngleMeasurement): string {
  switch (a.kind) {
    case 'points':
      return formatThreePointAngle(
        threePointAngle(a.picks[0].point, a.picks[1].point, a.picks[2].point),
      );
    case 'edges':
      return formatAnglePair(
        edgePairAngle(a.picks[0].point, a.picks[1].point, a.picks[2].point, a.picks[3].point),
      );
    case 'faces':
      // Pass the absence through rather than substituting a zero vector: a
      // missing normal is an upstream bug and must not render as a
      // measurement error the user could have caused.
      return formatAnglePair(facePairAngle(a.picks[0].normal, a.picks[1].normal));
  }
}

/**
 * Readout for a radius/diameter pick sequence. Shared between the
 * in-progress sequence and finished measurements: below the fit's minimum
 * this renders `fitRadius`'s own "Pick N more points" wording, so the SAME
 * readout updates live as points are added.
 */
export function formatRadiusPoints(
  points: readonly RadiusPoint3[],
  unitDisplayOverrides: Record<string, string>,
): string {
  return formatRadius(fitRadius(points), (m) => formatDistance(m, unitDisplayOverrides));
}
