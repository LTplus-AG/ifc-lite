/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.georef.check()`: collect the facts, build the capabilities
 * (`capabilities.ts`), diagnose, and say what could not be checked.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { collectGeorefFacts, crsRequirements, diagnoseGeoreference, type SkippedCheck } from '@ifc-lite/georef-check';
import { GeoreferencingError } from '../types.js';
import { composeCatalog, crsEngine, crsNames, geoNameIndex, loadEpsgCatalog, resolveRequirements, type LoadedCatalog } from './capabilities.js';
import { deriveSitePosition } from './site-derivation.js';
import type { GeorefCheckOptions, GeorefCheckReport, GeorefCrsResolution } from './types.js';

/** Append what would enable a skipped check, when a missing capability is the cause. */
function withCapabilityHints(skipped: SkippedCheck[], crs: GeorefCrsResolution[], catalog: LoadedCatalog | null): SkippedCheck[] {
  return skipped.map((s) => {
    const unresolved = crs.find((c) => !c.resolved && s.reason.includes(`EPSG:${c.epsg}`));
    if (unresolved?.note) return { ...s, reason: `${s.reason} ${unresolved.note}` };
    if (!catalog && /crsCatalog|area of use/i.test(s.reason)) return { ...s, reason: `${s.reason} (The bundled EPSG area-of-use catalogue could not be loaded.)` };
    return s;
  });
}

export async function checkGeoreferencing(
  store: IfcDataStore,
  options: GeorefCheckOptions = {},
  includesSessionEdits = false,
): Promise<GeorefCheckReport> {
  const facts = collectGeorefFacts(store);
  if (!facts) {
    throw new GeoreferencingError('UNSUPPORTED_SCHEMA', 'georef check reads IFC STEP models; this model has no STEP source (IFCX or tabular).');
  }
  const network = options.allowNetwork === true;
  const engine = crsEngine(network);
  let catalog: LoadedCatalog | null = null;
  try {
    catalog = await loadEpsgCatalog();
  } catch (error) {
    // The catalogue is bundled; failing to load it is reported, not fatal: the
    // checks that need it are listed as skipped.
    console.warn(`[georef check] EPSG catalogue unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const crsCatalog = composeCatalog(catalog?.catalog ?? null, await geoNameIndex(engine, crsNames(facts)));
  const requirements = crsRequirements(facts, { crsCatalog });
  const { reprojector, transformers, resolutions } = await resolveRequirements(engine, requirements, network);
  const report = diagnoseGeoreference(facts, { reprojector, crsCatalog });
  return {
    ...report,
    skipped: withCapabilityHints(report.skipped, resolutions, catalog),
    schemaVersion: facts.schemaVersion,
    facts,
    capabilities: { network, crsCatalog: catalog?.datasetVersion ?? null, crs: resolutions },
    siteDerivation: deriveSitePosition(facts, report, requirements[0], transformers, crsCatalog),
    includesSessionEdits,
  };
}
