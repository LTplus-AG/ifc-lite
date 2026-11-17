/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shapes of the georeferencing doctor: `bim.georef.check()` (a
 * `@ifc-lite/georef-check` report plus what the check could use) and
 * `bim.georef.planFixes()` / `bim.georef.fix()`.
 */

import type { FieldChange, GeorefFacts, GeorefReport, Severity } from '@ifc-lite/georef-check';
import type { GeorefSiteInput, GeoreferencingSetInput, GeoreferencingUpdateInput } from '../types.js';

export interface GeorefCheckOptions {
  /**
   * Allow network access: EPSG definitions from epsg.io for codes the bundled
   * index lacks, and datum-shift grids from cdn.proj.org. Off by default, so a
   * check makes no request; the checks that needed them are listed as skipped.
   */
  allowNetwork?: boolean;
}

/** How the datum shift to WGS84 of a resolved CRS is done (`@ifc-lite/geo`'s `CrsDatumShift`). */
export type GeorefDatumShift = 'as-defined' | 'helmert-approximation' | 'grid-unavailable';

/** One CRS the check needed to reproject from, and whether it could. */
export interface GeorefCrsResolution {
  epsg: number;
  resolved: boolean;
  datumShift?: GeorefDatumShift;
  /** Why it could not be resolved, or what its datum shift means. */
  note?: string;
}

/**
 * IfcSite RefLatitude/RefLongitude (and RefElevation, only with a stated
 * vertical datum) derived from the map conversion through the reprojector.
 * `blockedBy` lists why it must not be used; `approximateDatum` alone is
 * lifted by `acceptApproximateDatum`.
 */
export interface GeorefSiteDerivation {
  latitude?: number;
  longitude?: number;
  /** Project length units; only when the CRS states a VerticalDatum. */
  elevation?: number;
  epsg?: number;
  datumShift?: GeorefDatumShift;
  blockedBy: Array<{ reason: 'approximateDatum' | 'implausible' | 'unavailable'; detail: string }>;
}

export interface GeorefCheckReport extends GeorefReport {
  schemaVersion: string;
  /** The facts the diagnosis read (the model as it would be exported, session edits included). */
  facts: GeorefFacts;
  capabilities: {
    network: boolean;
    /** EPSG dataset version of the area-of-use catalogue, when it loaded. */
    crsCatalog: string | null;
    crs: GeorefCrsResolution[];
  };
  siteDerivation: GeorefSiteDerivation;
  /** True when this session held unsaved edits and the check read the model with them. */
  includesSessionEdits: boolean;
}

/**
 * - `ready`: goes through the write API with every value known; `fix()` applies it.
 * - `needs-value`: the write API can carry it once the user supplies `needs`.
 * - `review`: the checker marks it uncertain (a caveat), or a derived value
 *   failed the plausibility gate: never applied.
 * - `manual`: the write API cannot carry it.
 * - `alternative`: a safe fix the finding offers besides its preferred one;
 *   choose it by id.
 * - `conflict`: it would set a value another chosen fix sets differently.
 */
export type GeorefPlannedFixStatus = 'ready' | 'needs-value' | 'review' | 'manual' | 'alternative' | 'conflict';

export type GeorefPlannedWrite =
  | { via: 'georef.update'; input: GeoreferencingUpdateInput }
  | { via: 'georef.set'; input: GeoreferencingSetInput }
  | { via: 'georef.site'; input: GeorefSiteInput };

export interface GeorefPlannedFix {
  /** Stable within a report: `<CODE>.<n>` (n = the fix's place in its finding, from 1). */
  id: string;
  code: GeorefReport['findings'][number]['code'];
  severity: Severity;
  summary: string;
  caveat?: string;
  status: GeorefPlannedFixStatus;
  /** Why it has this status, in one sentence. */
  reason: string;
  /** The field changes, as the checker states them (null: user-supplied). */
  changes: FieldChange[];
  /** The write, with supplied and derived values filled in; absent for `manual`. */
  write?: GeorefPlannedWrite;
  /** Paths still to supply (`ProjectedCRS.Name`, `IfcSite.RefLatitude`), with the current value when the model has one. */
  needs?: Array<{ path: string; current?: string | number }>;
  /** Values the plan derived rather than took from the checker or the user. */
  derived?: Record<string, number>;
  /** Set on a fix that is not its finding's chosen one: the id applied instead unless this one is chosen. */
  alternativeTo?: string;
}

export interface GeorefFixPlanOptions {
  /** Fix ids to apply instead of their finding's preferred fix. */
  choose?: readonly string[];
  /** User-supplied values by path: `ProjectedCRS.Name` → `EPSG:2056`, `IfcSite.RefLatitude` → 47.1. */
  values?: Readonly<Record<string, string | number>>;
  /** Use a site position derived through a Helmert approximation (or without a datum grid). Default false. */
  acceptApproximateDatum?: boolean;
}

export interface GeorefFixPlan {
  fixes: GeorefPlannedFix[];
}

export interface GeorefFixResult {
  /** Ids of the fixes applied. */
  applied: string[];
  /** The writes made, in order (at most one georeferencing write and one site write). */
  writes: Array<{ via: GeorefPlannedWrite['via']; notes: string[] }>;
}
