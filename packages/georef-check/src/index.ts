/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/georef-check — diagnose what is wrong with a model's
 * georeferencing and say how to fix it. `diagnoseGeoreference` is a pure
 * function from {@link GeorefFacts} to a {@link GeorefReport};
 * `collectGeorefFacts` reads those facts from a parsed `IfcDataStore`.
 */

export { crsRequirements, diagnoseGeoreference, georeferencingLevels } from './diagnose.js';
export { collectGeorefFacts, type CollectGeorefFactsOptions } from './facts-from-store.js';
export type {
  CoordinateMagnitudes,
  CrsCatalog,
  CrsCatalogEntry,
  CrsFact,
  CrsRequirement,
  DiagnoseOptions,
  FieldChange,
  FixApplication,
  GeorefFacts,
  GeorefFinding,
  GeorefFindingCode,
  GeorefIndicators,
  GeorefLevel,
  GeorefReport,
  GeoreferenceSourceFact,
  GeorefSiteWriteInput,
  GeorefWriteInput,
  OperationFact,
  PointFamilyStats,
  Reprojector,
  RootSpatialPlacementFact,
  Severity,
  SiteLocationFact,
  SkippedCheck,
  SuggestedFix,
  Vec2,
  Vec3,
} from './types.js';
