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
