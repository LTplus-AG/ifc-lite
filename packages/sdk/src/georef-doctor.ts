/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The georeferencing doctor on its own (`@ifc-lite/sdk/georef-doctor`), for
 * hosts that hold their georeference edits outside a `bim` session and load
 * the checker lazily (the viewer's Georeference panel, #10608): collect the
 * facts, patch the edits in, check, and plan the fixes with the same safety
 * rules as `bim.georef.planFixes`.
 */

export { collectGeorefFacts } from '@ifc-lite/georef-check';
export type { CrsFact, GeorefFacts, GeorefFinding, GeorefFindingCode, OperationFact, Severity } from '@ifc-lite/georef-check';
export { checkGeorefFacts } from './georef/doctor/check.js';
export { planGeorefFixes } from './georef/doctor/plan.js';
export type { GeorefCheckReport, GeorefFixPlan, GeorefPlannedFix, GeorefPlannedWrite } from './georef/doctor/types.js';
