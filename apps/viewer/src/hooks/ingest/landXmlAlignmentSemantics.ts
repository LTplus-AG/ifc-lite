/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Durable browser-facing records for LandXML horizontal alignments. */

import type { LandXmlPlanPoint } from './landXmlSemantics.js';

export type LandXmlPointLocation =
  | { kind: 'coordinates'; point: LandXmlPlanPoint }
  | { kind: 'point_reference'; pntRef: string };
export type LandXmlRadius = number | 'infinite';
export interface LandXmlAlignmentPi { sourceId: string; location: LandXmlPointLocation }
export interface LandXmlStationEquation {
  sourceId: string; staInternal: number; staAhead: number; staBack: number | null; staIncrement: string | null;
}
export interface LandXmlAlignmentSegment {
  sourceId: string;
  ordinal: number;
  primitive: LandXmlAlignmentPrimitive;
  /** Canonical Rust-evaluated display samples for curves and supported transitions. */
  renderPoints?: LandXmlPlanPoint[];
}
export interface LandXmlCantStation {
  sourceId: string; station: number; appliedCant: number; equilibriumCant: number | null;
  curvature?: 'clockwise' | 'counter_clockwise'; cantDeficiency?: number | null; cantExcess?: number | null;
  rateOfChangeOfAppliedCantOverTime?: number | null; rateOfChangeOfAppliedCantOverLength?: number | null;
  rateOfChangeOfCantDeficiencyOverTime?: number | null; cantGradient?: number | null; speed?: number | null;
  transitionType: string | null; adverse?: boolean | null;
}
export interface LandXmlSuperelevationEvent { sourceId: string; kind: string; value: string | null }
export interface LandXmlSuperelevation {
  sourceId: string; staStart: number | null; staEnd: number | null; events: LandXmlSuperelevationEvent[];
}
/** A refusal is distinct while `sourceSourceId` preserves authored identity. */
export interface LandXmlUnsupportedTransition {
  sourceId: string; sourceSourceId: string; spiType: string; reason: string;
}
export type LandXmlAlignmentPrimitive =
  | { kind: 'line'; start: LandXmlPointLocation; end: LandXmlPointLocation; declaredLength: number | null }
  | { kind: 'irregular_line'; start: LandXmlPointLocation; end: LandXmlPointLocation; points: LandXmlPlanPoint[]; declaredLength: number | null }
  | { kind: 'curve'; start: LandXmlPointLocation; center: LandXmlPointLocation; end: LandXmlPointLocation; pi?: LandXmlPointLocation | null; rotation: 'clockwise' | 'counter_clockwise'; radius: number | null; declaredLength: number | null }
  | { kind: 'spiral' | 'unsupported_spiral'; start: LandXmlPointLocation; pi: LandXmlPointLocation; end: LandXmlPointLocation; spiType: string; radiusStart?: LandXmlRadius; radiusEnd?: LandXmlRadius; rotation?: 'clockwise' | 'counter_clockwise'; declaredLength: number };
export interface LandXmlAlignment {
  sourceId: string; ordinal: number; name: string; length: number; staStart: number;
  profileSourceIds: string[]; crossSectionSourceIds: string[]; segments: LandXmlAlignmentSegment[];
  start?: LandXmlPointLocation | null; alignPis?: LandXmlAlignmentPi[]; stationEquations?: LandXmlStationEquation[];
  cantStations: LandXmlCantStation[]; superelevations: LandXmlSuperelevation[];
  unsupportedTransitions: LandXmlUnsupportedTransition[];
}
