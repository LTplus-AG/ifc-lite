/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/flood-check: check a georeferenced building model against a
 * surface-runoff hazard map. This release reads the model: the elements a
 * flood check needs (doors, windows, openings, light wells, external stairs
 * and ramps, technical equipment in the lowest storeys), each with its map
 * position, its level and the quality of both, the building footprint with an
 * accumulated quality record, and every element skipped with its reason. The
 * hazard-map check, the BAFU provider and the property-set payloads follow.
 */

export type { MapBBox, MapPoint } from './types.js';
export { FloodCheckError, FloodCheckRefusal, type RefusalCode } from './errors.js';
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
