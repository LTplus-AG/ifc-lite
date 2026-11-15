/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The model facts the check reads: plain data, so a caller can also build them by hand. */

import type { MapPoint } from '../types.js';
import type { ModelGeoreference } from './georef.js';

export type CandidateCategory =
  | 'door'
  | 'window'
  | 'basement-window'
  | 'wall-opening'
  | 'slab-opening'
  | 'light-well'
  | 'stair'
  | 'ramp'
  | 'equipment';

/**
 * How a candidate's level was obtained.
 * - `placement-origin`: the element's own placement origin (doors: threshold;
 *   windows: sill in the common authoring convention; equipment: base).
 * - `opening-body-bottom`: the lowest point of an opening's extruded body (its sill).
 * - `host-slab-top`: the placement of the slab an opening cuts.
 * - `ground-storey-level`: no top edge could be read (external stairs and
 *   ramps); the ground storey level is used and is an UPPER estimate.
 * - `given`: supplied by the caller.
 */
export type LevelBasis = 'placement-origin' | 'opening-body-bottom' | 'host-slab-top' | 'ground-storey-level' | 'given';

/** One element where water could enter or do damage. */
export interface CandidateFact {
  expressId: number;
  globalId: string | null;
  name: string | null;
  /** Exact IFC class as the file declares it, for example `IfcDoor`. */
  ifcClass: string;
  predefinedType: string | null;
  category: CandidateCategory;
  /** Plan position in map coordinates, metres. */
  position: MapPoint;
  /** The lowest relevant level (threshold, sill, top edge, base), absolute metres in the model's vertical datum. */
  level: number;
  levelBasis: LevelBasis;
  /** True when `level` may be higher than the real entry level, so it can flag but never clear. */
  levelIsUpperEstimate: boolean;
  storeyId: number | null;
  /** Why the element was selected, for example `IsExternal`, `on footprint boundary`, `IfcBoiler`. */
  selectedBecause: string;
  host?: { expressId: number; ifcClass: string };
}

export interface StoreyFact {
  expressId: number;
  globalId: string | null;
  name: string | null;
  /** Absolute level of the storey placement, metres. */
  level: number;
}

export interface SpaceFact {
  expressId: number;
  globalId: string | null;
  name: string | null;
  storeyId: number | null;
  /** Absolute level of the space placement (its floor in the usual convention), metres. */
  floorLevel: number;
}

export type FootprintSource = 'given' | 'slab-outline' | 'external-wall-hull' | 'candidate-hull';

export interface FootprintFact {
  /** Rings in map coordinates; a point inside any ring is inside the building. */
  rings: MapPoint[][];
  source: FootprintSource;
  /** Slabs or walls the rings were read from. */
  fromElements: number[];
}

export interface ModelFacts {
  georeference: Omit<ModelGeoreference, 'toMap'>;
  footprint: FootprintFact;
  storeys: StoreyFact[];
  groundStorey: { expressId: number | null; level: number; basis: 'given' | 'project-zero' | 'lowest-storey' | 'none' };
  candidates: CandidateFact[];
  spaces: SpaceFact[];
  /** Elements skipped (no readable placement), with the reason. */
  skipped: Array<{ expressId: number; ifcClass: string; reason: string }>;
  warnings: string[];
}
