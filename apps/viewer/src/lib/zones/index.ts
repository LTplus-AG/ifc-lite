/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type {
  Zone,
  ZoneSet,
  ElementAABB,
  ZoneAssignment,
  ZoneAssignmentsByElement,
  ZoneSetFile,
  ZoneSetFileV1,
} from './types.js';
export { ZONE_SET_FILE_VERSION } from './types.js';

export {
  worldToZoneLocal,
  isPointInZone,
  aabbCentroid,
  zoneOverlapsAABB,
  zoneWorldCorners,
  zoneWorldAABB,
  compileZone,
  isPointInCompiledZone,
  zoneOverlapsAABBCompiled,
  type CompiledZone,
} from './geometry.js';

export { assignElementsToZoneSet, assignElementsToZoneSets, STRADDLE_PENETRATION_M } from './assignment.js';

// `prism.ts` is deliberately NOT re-exported here. Its consumers are this
// folder (`geometry`, `apportionment`, `persistence`) plus `zonesSlice`, which
// deep-imports it exactly as it already deep-imports `types` and `persistence`.
// Re-exporting would widen this barrel for one caller that does not use it.

export {
  generateStoreyZones,
  DEFAULT_STOREY_ZONE_HEIGHT_M,
  MIN_STOREY_ZONE_HEIGHT_M,
  type StoreyInfo,
  type XYBounds,
} from './storey-generation.js';

export { serializeZoneSets, parseZoneSetFile, type ParseZoneSetFileResult } from './persistence.js';

export { zoneColorForIndex } from './colors.js';

export {
  apportionElementVolume,
  clippedVolumeForZone,
  meshVolume,
  SUM_TOLERANCE_REL,
  NEGLIGIBLE_SHARE_REL,
  type ElementMeshPiece,
  type ElementApportionment,
  type ZoneVolumeShare,
} from './apportionment.js';

export {
  withInheritedTypeQuantities,
  type InheritableQuantitySet,
  type TypeQuantityStoreLike,
} from './inherited-quantities.js';

export {
  zoneSetRevision,
  validEntry,
  coverageOf,
  volumeGateVerdict,
  PROVED_VOLUME_AGREEMENT_REL,
  type ApportionmentRefusal,
  type ZoneApportionmentEntry,
  type ZoneApportionmentCache,
  type ApportionmentCoverage,
} from './apportionment-cache.js';

export {
  buildElementWriteBack,
  summarize,
  zonePropertySetName,
  zoneQuantitySetName,
  zoneQuantitySetPrefix,
  OUTSIDE_QUANTITY_NAME,
  UNNAMED_ZONE,
  ZONE_PROPERTY_NAMES,
  ZONE_SET_NAME_PREFIX,
  ZONE_QUANTITY_SET_NAME_PREFIX,
  type ElementZoneFacts,
  type ElementWriteBack,
  type WriteBackRefusal,
  type WriteBackSummary,
  type ZoneWriteBackOptions,
} from './writeback.js';

export {
  allBasisBreakdowns,
  basisBreakdown,
  declaredVolumeBases,
  volumeBasisFromQuantityName,
  volumeBasisLabel,
  volumeBasisRatioNote,
  VOLUME_BASIS_LEGEND,
  VOLUME_QUANTITY_TYPE,
  type VolumeBasis,
  type DeclaredVolume,
  type BasisBreakdown,
  type BasisShare,
  type QuantityLike,
  type QuantitySetLike,
} from './volume-basis.js';
