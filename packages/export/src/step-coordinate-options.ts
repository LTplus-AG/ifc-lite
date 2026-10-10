/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

/** Coordinate compatibility adaptations are explicitly opt-in. */
export interface StepCoordinateNormalizationOptions {
  /** Normalize emitted IfcProjectedCRS map units to metres, preserving the
   * complete map transformation and all project geometry/units. Default false.
   * Unsupported or ambiguous units/operations are preserved with warnings.
   * Requires a full export to the source STEP schema (not deltaOnly).
   */
  normalizeMapUnitsToMetres?: boolean;
  /**
   * Canonical Rust compatibility export, requiring exportAsync and a metre
   * MapUnit. Uniform map rotation/scale moves into logical placements and
   * mapped Body geometry; project/property units remain authored. Unsupported
   * coordinate consumers produce atomic warnings; upload must refuse these.
   * Default: preserve. Requires full geometry in the unchanged source schema.
   */
  normalizeMapGeometry?: boolean;
  /**
   * Write recognized EVRS2007 or EGM2008 IfcProjectedCRS.VerticalDatum names
   * as 'EPSG:3855' (EGM2008 height), the geoid Cesium ion applies. Explicit
   * EPSG codes, ellipsoidal names and unrecognized datum text are preserved;
   * heights are never rewritten. Default false. Requires a full export to
   * the source schema.
   */
  normalizeVerticalDatumToEgm2008?: boolean;
}

/** Authored coordinate-system edits applied before compatibility phases. */
export interface StepGeoreferencingOptions {
  /** Georeferencing mutations to apply (IfcProjectedCRS / IfcMapConversion edits) */
  georefMutations?: {
    projectedCRS?: Partial<ProjectedCRS>;
    mapConversion?: Partial<MapConversion>;
  };
}
