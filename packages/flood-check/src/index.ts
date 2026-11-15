/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/flood-check: check a georeferenced building model against a
 * surface-runoff hazard map. Which openings, light wells, ramps and technical
 * equipment sit below the mapped water-depth class next to the building.
 */

export {
  CELL_NO_RUNOFF,
  CELL_UNCLASSIFIED,
  type ClassifiedHazardRaster,
  type BuildingFootprintSource,
  type CoverageTest,
  type OtherBuildingFootprints,
  type HazardCellCounts,
  type HazardClassDefinition,
  type HazardProvenance,
  type HazardProvider,
  type HazardRasterRequest,
  type LocalizedText,
  type MapBBox,
  type MapPoint,
  type RenderingConfirmation,
  type TerrainGrid,
  type TerrainSampler,
  type TerrainSource,
} from './types.js';
export {
  FloodCheckError,
  FloodCheckRefusal,
  HazardRequestError,
  HazardResponseError,
  HazardStyleChangedError,
  type RefusalCode,
  type UnexplainedColour,
} from './errors.js';
export {
  createBafuRunoffProvider,
  type BafuProviderOptions,
  type CachedHazardResponse,
  type HazardResponseCache,
} from './bafu/provider.js';
export {
  BAFU_ATTRIBUTION,
  BAFU_CLASSES,
  BAFU_CRS,
  BAFU_DATASET_DATE,
  BAFU_DISCLAIMER,
  BAFU_LAYER,
  BAFU_LEGEND,
  BAFU_LICENCE,
  BAFU_LIMITS,
  BAFU_RETURN_PERIOD,
  BAFU_SCALE_LIMIT_DENOMINATOR,
  BAFU_TITLE,
} from './bafu/dataset.js';
export type { LegendEntry } from './legend.js';
export { extractModelFacts, type ExtractOptions } from './model/extract.js';
export type { GeoreferenceOptions, ModelGeoreference } from './model/georef.js';
export { buildingLabel } from './model/facts.js';
export type {
  BuildingRef,
  BuildingScope,
  CandidateCategory,
  CandidateFact,
  FootprintFact,
  FootprintQuality,
  FootprintQualityRecord,
  FootprintSource,
  LevelBasis,
  ModelFacts,
  SpaceFact,
  StoreyFact,
} from './model/facts.js';
export {
  checkFloodExposure,
  type CandidateResult,
  type CheckOptions,
  type DrivingSample,
  type FloodCheckResult,
  type LayerCheck,
  type ReachableSpace,
  type SampleCounts,
} from './check/check.js';
export { CONFIRMATION_MAX_AGE_MS } from './check/layer.js';
export type { MarginBasis, MarginOptions } from './check/margin.js';
export type { EntryCheck, HeightPlausibility, HeightReference, PlausibilityOptions } from './check/plausibility.js';
export { compareLevel, type LevelComparison, type Outcome, type UnclassifiedReason } from './check/outcome.js';
export { terrainSamplerFromGrid, type ResolvedSampling } from './check/sampling.js';
export { runFloodCheck, type RunOptions } from './check/run.js';
export {
  ELEMENT_PSET,
  SITE_PSET,
  toPropertySets,
  type ElementPropertySet,
  type FloodProperty,
  type FloodPropertySet,
  type FloodPropertyType,
} from './psets.js';
