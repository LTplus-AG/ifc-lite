/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The structural view of a parsed LandXML document that the IFC mapping reads.
 *
 * Declared here rather than imported from the viewer on purpose: a converter
 * that cannot be unit-tested without mounting the viewer is not a converter.
 * The viewer's `LandXmlTinDocument` satisfies these shapes structurally, so the
 * adaptation is a type assignment and not a translation layer that could drift.
 *
 * Everything the mapping refuses (§5, §11.5 of the mapping spec) appears here as an
 * opaque `readonly unknown[]`. That is deliberate: the converter must *count and
 * name* those records to refuse them honestly, and must not be able to read
 * into them, which is what would let a refusal quietly become a partial export.
 */

/** A TIN vertex, in LandXML's own authored order. */
export interface LandXmlIfcPoint {
  /** Document-local id, e.g. `landxml:surface:3:point:41`. Seeds the GlobalId. */
  sourceId: string;
  /** The `<P id="...">` attribute, which `<F>` entries reference. */
  id: string;
  northing: number;
  easting: number;
  elevation: number;
}

export interface LandXmlIfcSurface {
  sourceId: string;
  name: string;
  kind: string;
  /** Only `'rendered'` is in scope; anything else is refused by name (§5). */
  renderState: string;
  points: readonly LandXmlIfcPoint[];
  /** Triples of `<P>` ids, as authored. */
  faces: readonly (readonly [string, string, string])[];
  /** Per-face; a `false` entry is an authored `<F i="true">`. */
  faceVisibility?: readonly boolean[];
  boundaries?: readonly unknown[];
  breaklines?: readonly unknown[];
  contours?: readonly unknown[];
}

/** A `<CgPoint>` location. `elevation` is genuinely optional in LandXML. */
export interface LandXmlIfcPlanPoint {
  northing: number;
  easting: number;
  elevation: number | null;
}

export interface LandXmlIfcCgPoint {
  sourceId: string;
  name: string | null;
  code: string | null;
  description: string | null;
  point: LandXmlIfcPlanPoint | null;
}

export interface LandXmlIfcPlan {
  cogoPoints?: readonly LandXmlIfcCgPoint[];
  monuments?: readonly unknown[];
  planFeatures?: readonly unknown[];
  parcels?: readonly unknown[];
}

/**
 * Units as the parser resolved them. `null` only for a source that declares
 * none — which a renderable TIN cannot be (LXML009), so `null` here means the
 * document carries no numeric surface at all.
 */
export interface LandXmlIfcUnits {
  linearUnit: string;
  elevationUnit: string;
  linearScaleToMeters: number;
  /** LandXML may declare a different unit for elevation than for plan. */
  elevationScaleToMeters: number;
  /** True when an operator supplied the unit for an undeclared source (§2.1). */
  assumed: boolean;
}

/** A plan location: authored coordinates, or a reference to a `CgPoint` by name. */
export type LandXmlIfcLocation =
  | { kind: 'coordinates'; point: { northing: number; easting: number } }
  | { kind: 'point_reference'; pntRef: string };

/** `'infinite'` is LandXML's `INF` radius — a straight end of a spiral. */
export type LandXmlIfcRadius = number | 'infinite';

export type LandXmlIfcRotation = 'clockwise' | 'counter_clockwise';

/**
 * One `CoordGeom` element, in the authored northing-first plan. Mirrors the
 * viewer's `LandXmlAlignmentPrimitive` field for field, so the viewer's
 * document assigns to this without a translation layer.
 */
export type LandXmlIfcAlignmentPrimitive =
  | { kind: 'line'; start: LandXmlIfcLocation; end: LandXmlIfcLocation; declaredLength: number | null }
  | { kind: 'irregular_line'; start: LandXmlIfcLocation; end: LandXmlIfcLocation; declaredLength: number | null }
  | {
    kind: 'curve'; start: LandXmlIfcLocation; center: LandXmlIfcLocation; end: LandXmlIfcLocation;
    rotation: LandXmlIfcRotation; radius: number | null; declaredLength: number | null;
  }
  | {
    kind: 'spiral' | 'unsupported_spiral'; start: LandXmlIfcLocation; pi: LandXmlIfcLocation;
    end: LandXmlIfcLocation; spiType: string; radiusStart?: LandXmlIfcRadius; radiusEnd?: LandXmlIfcRadius;
    rotation?: LandXmlIfcRotation; declaredLength: number;
  };

export interface LandXmlIfcAlignmentSegment {
  sourceId: string;
  ordinal: number;
  primitive: LandXmlIfcAlignmentPrimitive;
}

/**
 * A horizontal alignment (§11). Only the horizontal geometry is read; the
 * vertical, cant and superelevation records are counted so they can be
 * refused by name, never read into.
 */
export interface LandXmlIfcAlignment {
  sourceId: string;
  name: string;
  /** Station at the start, in the declared linear unit. */
  staStart: number;
  segments: readonly LandXmlIfcAlignmentSegment[];
  profileSourceIds?: readonly string[];
  stationEquations?: readonly unknown[];
  cant?: unknown;
  cantStations?: readonly unknown[];
  superelevations?: readonly unknown[];
}

export interface LandXmlIfcSource {
  schema: string;
  version: string;
  units: LandXmlIfcUnits | null;
  coordinateSystem?: { horizontalDatum?: string; verticalDatum?: string };
  surfaces: readonly LandXmlIfcSurface[];
  alignments?: readonly LandXmlIfcAlignment[];
  profiles?: readonly unknown[];
  crossSections?: readonly unknown[];
  crossSectionSurfaces?: readonly unknown[];
  roadways?: readonly unknown[];
  plan?: LandXmlIfcPlan;
  pipeNetworks?: { networks?: readonly unknown[] } | null;
}
