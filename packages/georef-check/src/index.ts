/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/georef-check — diagnose what is wrong with a model's
 * georeferencing and say how to fix it. `diagnoseGeoreference` is a pure
 * function from {@link GeorefFacts} to a {@link GeorefReport};
 * `collectGeorefFacts` reads those facts from a parsed `IfcDataStore`.
 */

export { diagnoseGeoreference, georeferencingLevels } from './diagnose.js';
export { collectGeorefFacts, type CollectGeorefFactsOptions } from './facts-from-store.js';
export type {
  CoordinateMagnitudes,
  CrsCatalog,
  CrsCatalogEntry,
  CrsFact,
  DiagnoseOptions,
  FieldChange,
  GeorefFacts,
  GeorefFinding,
  GeorefFindingCode,
  GeorefLevel,
  GeorefReport,
  GeoreferenceSourceFact,
  OperationFact,
  Reprojector,
  Severity,
  SiteLocationFact,
  SkippedCheck,
  SuggestedFix,
  Vec2,
  Vec3,
} from './types.js';
