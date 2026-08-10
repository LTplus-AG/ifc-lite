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
