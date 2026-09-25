/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a LandXML→IFC conversion returns.
 *
 * The result is a discriminated union rather than a string plus an error
 * channel, because §6 of the mapping makes refusal a first-class outcome: a
 * source with no in-scope record must refuse outright, not hand back a valid,
 * empty, useless IFC. A caller cannot reach `content` without having seen
 * which of the two happened.
 */

import type { LandXmlIfcUnits } from './source-types.js';

/**
 * A LandXML record family the v1 mapping does not cover (§5).
 *
 * Named, never silently dropped — the family names are the vocabulary the
 * export dialog shows the user before they commit.
 */
export type LandXmlRefusedFamily =
  | 'alignments'
  | 'profiles'
  | 'cross-sections'
  | 'roadways'
  | 'parcels'
  | 'monuments'
  | 'plan-features'
  | 'pipe-networks'
  | 'surface-boundaries'
  | 'surface-breaklines'
  | 'surface-contours'
  | 'non-rendered-surfaces'
  | 'unlocated-cgpoints'
  | 'station-equations'
  | 'cant'
  | 'superelevation';

export interface LandXmlRefusal {
  family: LandXmlRefusedFamily;
  /** How many records of this family the source holds. Always ≥ 1. */
  count: number;
  /** One sentence, addressed to the operator, saying what is left out and why. */
  message: string;
}

/** A condition worth surfacing that does not stop the export (§9.1). */
export interface LandXmlIfcWarning {
  /** Stable code so the UI can style or suppress by kind, never by text. */
  code: 'LXIFC-COORD-ORDER' | 'LXIFC-ASSUMED-UNIT' | 'LXIFC-NO-CRS' | 'LXIFC-COORD-SWAPPED';
  message: string;
}

export interface LandXmlIfcCoverage {
  /** TIN surfaces written as `IfcGeographicElement`/`.TERRAIN.`. */
  surfaces: number;
  /** `<CgPoint>` records written as `IfcAnnotation`/`.SURVEY.`. */
  surveyPoints: number;
  /** Vertices across all written surfaces. */
  vertices: number;
  /** Triangles across all written surfaces. */
  triangles: number;
  /**
   * Horizontal alignments written as `IfcAlignment` (§11). `landXmlToIfc`
   * always sets it; it is optional only so that adding it is not a breaking
   * change to an interface v1.0 may already have published (#5370 review) —
   * read it as `coverage.alignments ?? 0`.
   */
  alignments?: number;
  /**
   * Design profiles written as `IfcAlignmentVertical` (§12). Optional for the
   * same reason as `alignments`: read it as `coverage.profiles ?? 0`.
   */
  profiles?: number;
}

/** What the produced file records about where it came from (§7). */
export interface LandXmlIfcProvenance {
  sourceFileName: string | null;
  sourceHash: string | null;
  mappingVersion: string;
  landXmlSchema: string;
  units: LandXmlIfcUnits | null;
  assumedLinearUnit: string | null;
  coordinateOrderSwapped: boolean;
  refusedFamilies: readonly LandXmlRefusedFamily[];
}

export type LandXmlIfcResult =
  | {
    status: 'exported';
    content: string;
    coverage: LandXmlIfcCoverage;
    provenance: LandXmlIfcProvenance;
    refusals: readonly LandXmlRefusal[];
    warnings: readonly LandXmlIfcWarning[];
  }
  | {
    status: 'refused';
    /** Why nothing could be written, naming what the source does contain. */
    reason: string;
    refusals: readonly LandXmlRefusal[];
    warnings: readonly LandXmlIfcWarning[];
  };
