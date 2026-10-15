/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The offset field's value, as a person reads it (#7545): the active plane's
 * distance in the PROJECT length unit, measured from the plane's datum, to the
 * millimetre, stepped by the user's step.
 *
 *  - A cardinal plane's offset is its world coordinate along the axis (the
 *    elevation of a Down plane); its datum is 0.
 *  - A face-picked plane's offset is measured from the face it was picked on:
 *    `0` at the face, negative into the solid. The store keeps the absolute
 *    `dot(point, normal)` (and the face-pick inset that keeps the cap from
 *    z-fighting, #5480); `custom.datum` is where "0" sits, so a fresh pick reads
 *    `0.000`, not the absolute number nobody can use.
 *  - An alignment-bound plane keeps its station distance in metres.
 *
 * Everything the store, renderer, BCF and saved sets hold stays metres; this
 * converts once, at the edge.
 */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { sceneLengthUnit, METRES, type LengthUnit } from '@/lib/section/section-length-unit';
import { useSectionDistance, type SectionDistance } from './useSectionDistance';
import { useSectionStep } from './sectionStep';

/** What the number is measured along: an elevation (`level`), a coordinate on the X or Y axis, a picked face, an alignment's station, or a share of the range. */
export type OffsetDatum = 'level' | 'x' | 'y' | 'face' | 'alignment' | 'percent';

export interface SectionOffset {
  kind: SectionDistance['kind'];
  datum: OffsetDatum;
  /** The number the field shows, in `unit`, from the datum. */
  value: number;
  /** Commit what the user typed or stepped to, in `unit`, from the datum. */
  onChange: (next: number) => void;
  /** One step, in `unit`. */
  step: number;
  min: number;
  max: number;
  snaps: readonly number[];
  unit: LengthUnit;
  /** Decimal places: millimetres in metres, and a sensible count in the other units. */
  precision: number;
  /** The underlying distance (metres, absolute), for callers that still speak it. */
  distance: SectionDistance;
}

function precisionFor(unit: LengthUnit): number {
  // Always resolve to the millimetre at least: 3 places in metres, 2 in centimetres, 0 in millimetres… but never fewer than 1 for feet/inches.
  const places = Math.round(-Math.log10(0.001 / unit.scale));
  return Math.min(4, Math.max(unit.scale >= 0.9 ? 3 : 1, places));
}

export function useSectionOffset(): SectionOffset {
  const distance = useSectionDistance();
  const models = useViewerStore((s) => s.models);
  const datumValue = useViewerStore((s) => (s.sectionPlane.custom && !s.sectionPlane.custom.alignment ? s.sectionPlane.custom.datum ?? 0 : 0));
  const stepM = useSectionStep((s) => s.stepM);
  const axis = useViewerStore((s) => s.sectionPlane.axis);

  return useMemo<SectionOffset>(() => {
    const speaksLength = distance.kind === 'world' || distance.kind === 'custom';
    const unit = speaksLength ? sceneLengthUnit(models.values()) : METRES;
    const datum = distance.kind === 'custom' ? datumValue : 0;
    const toField = (metres: number) => (Number.isFinite(metres) ? (metres - datum) / unit.scale : metres);
    const unitless = distance.kind === 'percent';
    return {
      kind: distance.kind,
      datum: distance.kind === 'custom' ? 'face' : distance.kind === 'alignment' ? 'alignment' : unitless ? 'percent' : axis === 'side' ? 'x' : axis === 'front' ? 'y' : 'level',
      value: toField(distance.value),
      onChange: (next) => distance.onChange(next * unit.scale + datum),
      step: unitless ? distance.step : speaksLength ? stepM / unit.scale : stepM,
      min: toField(distance.min),
      max: toField(distance.max),
      snaps: distance.snaps.map(toField),
      unit: unitless ? { scale: 1, symbol: '%' } : unit,
      precision: unitless ? 2 : precisionFor(unit),
      distance,
    };
  }, [distance, models, datumValue, stepM, axis]);
}
