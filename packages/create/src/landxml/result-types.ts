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

/**
 * Georeferenced imagery draped on the terrain, recorded as provenance (§15.5).
 * An imagery overlay is never a claim the LandXML contained it: LandXML has no
 * raster element. The texture itself is written afterwards, by the appearance
 * workspace's planner, on the TIN elements named in `surfaceElements`.
 */
export interface LandXmlIfcImagery {
  /** The image file as the operator supplied it. */
  sourceFileName: string;
  /** SHA-256 (hex) of the supplied image bytes. */
  sourceHash: string;
  /** How the image was placed: its world file, or its GeoTIFF tags. */
  placement: 'world file' | 'GeoTIFF';
  /** The image's CRS as declared, e.g. `EPSG:2056`. */
  crs: string;
  /** The planar projection (§15.3), in the terrain CRS's native plan units. */
  projection: {
    crs: string;
    origin: readonly [number, number];
    axisU: readonly [number, number];
    axisV: readonly [number, number];
    extent: readonly [number, number];
  };
  /** Fraction of written TIN vertices on the image, 0–1. */
  coveredFraction: number;
  /** Set when the shipped image is not the supplied one (a GeoTIFF transcoded to PNG). */
  shippedFileName?: string;
  shippedHash?: string;
}

/** A written terrain surface and the `IfcGeographicElement` carrying it. */
export interface LandXmlIfcSurfaceElement {
  /** The LandXML surface's source id, e.g. `landxml:surface:1`. */
  sourceId: string;
  /** Express id of its `IfcGeographicElement` in `content`. */
  expressId: number;
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
  /** Imagery provenance (§15.5); absent when none was exported. */
  imagery?: LandXmlIfcImagery;
}

export type LandXmlIfcResult =
  | {
    status: 'exported';
    content: string;
    coverage: LandXmlIfcCoverage;
    /**
     * Each written surface's element, so a caller can address it in
     * `content` — the imagery export textures these (§15.5). Optional only so
     * adding it is not a breaking change to a published result type.
     */
    surfaceElements?: readonly LandXmlIfcSurfaceElement[];
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
