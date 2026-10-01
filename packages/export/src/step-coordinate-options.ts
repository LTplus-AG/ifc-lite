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
}

/** Authored coordinate-system edits applied before compatibility phases. */
export interface StepGeoreferencingOptions {
  /** Georeferencing mutations to apply (IfcProjectedCRS / IfcMapConversion edits) */
  georefMutations?: {
    projectedCRS?: Partial<ProjectedCRS>;
    mapConversion?: Partial<MapConversion>;
  };
}
