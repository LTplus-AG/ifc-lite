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
 * - `opening-body-bottom`: the lowest point of an opening's extruded body (its
 *   sill): for an unfilled opening, and for a door or window whose filled
 *   opening reaches lower than its placement origin.
 * - `host-slab-top`: the placement of the slab an opening cuts.
 * - `ground-storey-or-terrain`: external stairs and ramps, whose real entry is
 *   at the terrain. `level` holds the ground storey level; the check compares
 *   the LOWER of it and the terrain at each ground sample, so any mapped depth
 *   class there makes the element `exposed`. An upper estimate.
 * - `given`: supplied by the caller.
 */
export type LevelBasis = 'placement-origin' | 'opening-body-bottom' | 'host-slab-top' | 'ground-storey-or-terrain' | 'given';

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
  /** True when `level` may be higher than the real entry level, so it can flag but never be favourable. */
  levelIsUpperEstimate: boolean;
  storeyId: number | null;
  /** Why the element was selected, for example `IsExternal`, `on footprint boundary`, `IfcBoiler`. */
  selectedBecause: string;
  host?: { expressId: number; ifcClass: string };
  /** Observations made while reading the element (for example a placement far from its opening's sill). */
  notes?: string[];
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

/**
 * `given` and `slab-outline` are real outlines, and so is `external-wall-outline`
 * (the external walls' axes chained into a closed ring). The two hulls fill
 * courtyards and notches, and so does `slab-outline-voids-filled` (a slab
 * outline whose inner boundaries, courtyards, are not kept), so no element
 * gets a reassuring outcome on them ({@link fillsCourtyards}).
 */
export type FootprintSource =
  | 'given'
  | 'slab-outline'
  | 'slab-outline-voids-filled'
  | 'external-wall-outline'
  | 'external-wall-hull'
  | 'candidate-hull';

/** Footprints that fill courtyards or notches, so the ground sampled may not be in front of an element. */
export function fillsCourtyards(source: FootprintSource): boolean {
  return source === 'external-wall-hull' || source === 'candidate-hull' || source === 'slab-outline-voids-filled';
}

export interface FootprintFact {
  /**
   * Rings in map coordinates; a point inside any ring is inside the building,
   * so a courtyard ring nested in an outer ring is filled (its elements get no
   * reassuring outcome: `courtyard-ring`).
   */
  rings: MapPoint[][];
  source: FootprintSource;
  /** Some ground-storey floor slab had no readable outline, so the rings may miss part of the building: no reassuring outcome. */
  partial?: boolean;
  /** Slabs or walls the rings were read from. */
  fromElements: number[];
}

/** An IfcBuilding, as the result names it. */
export interface BuildingRef {
  expressId: number;
  globalId: string | null;
  name: string | null;
}

/** `"Name" (GlobalId)`, or `#id` when the building states neither. */
export function buildingLabel(b: BuildingRef): string {
  const parts = [b.name ? `"${b.name}"` : null, b.globalId ? `(${b.globalId})` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : `#${b.expressId}`;
}

/**
 * Which building of the file was checked. The footprint is one building's
 * outline, so only that building's elements are checked; the others are named
 * with the number of candidate elements found in them, which get no result.
 */
export interface BuildingScope {
  /** The building of the ground storey; null when the file has at most one IfcBuilding and the storey is not placed in it. */
  checked: BuildingRef | null;
  notChecked: Array<BuildingRef & { candidatesNotChecked: number }>;
}

export interface ModelFacts {
  georeference: Omit<ModelGeoreference, 'toMap'>;
  footprint: FootprintFact;
  storeys: StoreyFact[];
  groundStorey: { expressId: number | null; level: number; basis: 'given' | 'project-zero' | 'lowest-storey' | 'none' };
  candidates: CandidateFact[];
  spaces: SpaceFact[];
  /** Absent on hand-built facts: then every candidate is taken to belong to the footprint's building. */
  buildingScope?: BuildingScope;
  /** Elements skipped (no readable placement, or in a building that was not checked), with the reason. */
  skipped: Array<{ expressId: number; ifcClass: string; reason: string }>;
  warnings: string[];
}
