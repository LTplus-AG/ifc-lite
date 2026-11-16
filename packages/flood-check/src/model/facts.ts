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
 * - `body-bottom`: the lowest point of the element's own body (a door, window
 *   or piece of equipment whose body reaches below its placement origin).
 * - `host-slab-top`: the placement of the slab an opening cuts.
 * - `ground-storey-or-terrain`: external stairs and ramps, whose real entry is
 *   at the terrain. `level` holds the ground storey level; the check compares
 *   the LOWER of it and the terrain at each ground sample, so any mapped depth
 *   class there makes the element `exposed`. An upper estimate.
 * - `given`: supplied by the caller.
 */
export type LevelBasis = 'placement-origin' | 'body-bottom' | 'opening-body-bottom' | 'host-slab-top' | 'ground-storey-or-terrain' | 'given';

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
  /**
   * The position is not proven (`locate`): read from part of a body, from a
   * clipped body's outer operand, or a placement standing in for a hole. The
   * ground next to it may not be the ground in front of the element.
   */
  positionIsUncertain?: boolean;
  /**
   * `level` is only a lower bound (read from a clipped body's outer operand,
   * which may have lost its bottom): the true level may be higher. Not exact,
   * so it must not stand in for an entry level (the height reference).
   */
  levelIsLowerBound?: boolean;
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

/**
 * How far the footprint can be trusted, worst last. `voids-filled` and `hull`
 * fill courtyards or notches, `oversized` reaches beyond the building's
 * external walls (a podium slab): all three are hull-like; `partial` misses
 * part of the building (an unreadable source, a wall or façade element
 * outside it);
 * `courtyard-ring` has a courtyard drawn as its own ring, which the footprint
 * fills (elements facing it are withheld individually).
 */
export type FootprintQuality = 'complete' | 'voids-filled' | 'oversized' | 'courtyard-ring' | 'partial' | 'hull';
export const FOOTPRINT_QUALITY_ORDER: readonly FootprintQuality[] = ['complete', 'voids-filled', 'oversized', 'courtyard-ring', 'partial', 'hull'];

/**
 * The footprint's quality as accumulated through every source tried
 * (`footprint.ts`): conditions and unreadable sources are only ever added,
 * so a later fallback cannot upgrade it.
 */
export interface FootprintQualityRecord {
  /** The worst condition met. */
  readonly worst: FootprintQuality;
  /** Every condition met, in the order encountered. */
  readonly conditions: readonly Exclude<FootprintQuality, 'complete'>[];
  /** Every source tried that could not be read, or only in part. */
  readonly unreadable: ReadonlyArray<{ expressId: number; ifcClass: string; reason: string }>;
  /** What checking the footprint against the building found (walls or façade elements outside it, walls well inside it). */
  readonly notes: readonly string[];
}

/**
 * What the check needs to know about a footprint: from its quality record
 * when it has one (extracted facts), else from its source (hand-built facts).
 * No rings at all misses the whole building.
 */
export function footprintConcerns(fp: FootprintFact): { hullLike: boolean; partial: boolean; worst: FootprintQuality } {
  const conditions = new Set<FootprintQuality>(fp.quality?.conditions ?? []);
  if (fillsCourtyards(fp.source)) conditions.add(fp.source === 'slab-outline-voids-filled' ? 'voids-filled' : 'hull');
  if (fp.partial || fp.rings.length === 0) conditions.add('partial');
  const worst = FOOTPRINT_QUALITY_ORDER.reduce<FootprintQuality>((w, q) => (conditions.has(q) ? q : w), 'complete');
  return { hullLike: conditions.has('hull') || conditions.has('voids-filled') || conditions.has('oversized'), partial: conditions.has('partial'), worst };
}

export interface FootprintFact {
  /**
   * Rings in map coordinates, read through the prepared footprint
   * (`region.ts`). In a given footprint a ring whose whole boundary lies inside
   * the others and that encloses 1 m² or more is a courtyard: a hole, open
   * ground (the `courtyard-ring` guard withholds reassuring outcomes next to
   * it); a smaller nested ring stays closed. Slab and wall rings never form
   * holes.
   */
  rings: MapPoint[][];
  /**
   * Indices into `rings` of holes in a slab outline that are open to the sky
   * (courtyards: no slab above covers them), read through `region.ts` as open
   * ground. Holes roofed by a slab above (shafts, stair openings, floor areas
   * under the building) are not listed: they stay filled.
   */
  courtyardRings?: number[];
  source: FootprintSource;
  /** The rings may miss part of the building (mirrors `quality.conditions` containing `partial`): no reassuring outcome. */
  partial?: boolean;
  /** The quality accumulated through every source tried; absent on hand-built facts. */
  quality?: FootprintQualityRecord;
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
  /**
   * The covered elements candidate selection walked, and how many of them it
   * skipped: `walked === candidates.length + skipped` (checked again by the
   * check). Absent on hand-built facts.
   */
  coverage?: { walked: number; skipped: number };
  /** Absent on hand-built facts: then every candidate is taken to belong to the footprint's building. */
  buildingScope?: BuildingScope;
  /**
   * Entities skipped, with the reason: covered elements candidate selection
   * did not keep (no `stage`), and, by their `stage`, footprint sources that
   * could not be read and storeys without a placement, which are not elements
   * walked and so not part of `coverage.skipped`.
   */
  skipped: Array<{ expressId: number; ifcClass: string; reason: string; stage?: 'footprint-source' | 'storey' }>;
  warnings: string[];
}
