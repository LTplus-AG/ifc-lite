/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6499: immutable spatial facts belong to the model slot, not its GUID roots. */
import { computeTransformMatrix, extractGeoreferencingOnDemand, type GeoreferenceInfo, type IfcDataStore } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { ModelSlot } from '@ifc-lite/collab';
import type { ViewerModelPayload } from '@/hooks/ingest/viewerModelIngest';
import { getEffectiveGeoreference, getIfcLengthUnitScale, type GeorefMutationDataLike } from '@/lib/geo/effective-georef';

interface RoomSpatialContext {
  version: 1;
  georeferencing: GeoreferenceInfo | null;
  coordinateInfo?: CoordinateInfo;
  lengthUnitScale: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function vector(value: unknown): boolean {
  return record(value) && finite(value.x) && finite(value.y) && finite(value.z);
}
function bounds(value: unknown): boolean {
  if (!record(value) || !vector(value.min) || !vector(value.max)) return false;
  const min = value.min as Record<string, number>, max = value.max as Record<string, number>;
  return min.x <= max.x && min.y <= max.y && min.z <= max.z;
}
function optionalNumbers(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => value[key] === undefined || finite(value[key]));
}
function optionalStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => value[key] === undefined || typeof value[key] === 'string');
}
function georeference(value: unknown): boolean {
  if (value === null) return true;
  if (!record(value) || typeof value.hasGeoreference !== 'boolean') return false;
  if (value.source !== undefined && !['mapConversion', 'ePSetMapConversion', 'siteLocation'].includes(String(value.source))) return false;
  if (value.mapConversion !== undefined) {
    const conversion = value.mapConversion;
    if (!record(conversion) || !['id', 'sourceCRS', 'targetCRS', 'eastings', 'northings', 'orthogonalHeight'].every(key => finite(conversion[key]))) return false;
    if (!optionalNumbers(conversion, ['xAxisAbscissa', 'xAxisOrdinate', 'scale', 'factorX', 'factorY', 'factorZ'])) return false;
  }
  if (value.projectedCRS !== undefined) {
    const crs = value.projectedCRS;
    if (!record(crs) || !finite(crs.id) || typeof crs.name !== 'string') return false;
    if (!optionalStrings(crs, ['description', 'geodeticDatum', 'verticalDatum', 'mapProjection', 'mapZone', 'mapUnit'])) return false;
    if (crs.mapUnitScale !== undefined && (!finite(crs.mapUnitScale) || crs.mapUnitScale <= 0)) return false;
  }
  return value.transformMatrix === undefined || (Array.isArray(value.transformMatrix)
    && value.transformMatrix.length === 16 && value.transformMatrix.every(finite));
}
function coordinateInfo(value: unknown): boolean {
  if (!record(value) || !vector(value.originShift) || !bounds(value.originalBounds) || !bounds(value.shiftedBounds)
    || typeof value.hasLargeCoordinates !== 'boolean') return false;
  if (!optionalNumbers(value, ['buildingRotation', 'lengthUnitScale', 'boundsRecoveryFallbackCount'])) return false;
  if (value.lengthUnitScale !== undefined && (value.lengthUnitScale as number) <= 0) return false;
  if (value.wasmRtcOffset !== undefined && !vector(value.wasmRtcOffset)) return false;
  return value.wasmRtcFrame === undefined || (vector(value.wasmRtcFrame)
    && record(value.wasmRtcFrame) && typeof value.wasmRtcFrame.needsShift === 'boolean');
}

/** One validator for owner writes and untrusted persisted/remote slot reads. */
export function decodeRoomSpatialContext(value: unknown): RoomSpatialContext | undefined {
  if (value === undefined) return undefined; // Rooms created before #6499 retain their zero frame.
  if (!record(value) || value.version !== 1 || !georeference(value.georeferencing)
    || !finite(value.lengthUnitScale) || value.lengthUnitScale <= 0
    || (value.coordinateInfo !== undefined && !coordinateInfo(value.coordinateInfo))) {
    throw new Error('The shared model has invalid or unsupported spatial metadata. Ask its owner to share it again.');
  }
  return value as unknown as RoomSpatialContext;
}

/** JSON copy: Yjs records are immutable values and must not alias the owner's live frame. */
export function createRoomSpatialContext(
  store: IfcDataStore,
  frame?: CoordinateInfo,
  mutations?: GeorefMutationDataLike,
): Record<string, unknown> {
  const effective = getEffectiveGeoreference(store, frame, mutations);
  const original = extractGeoreferencingOnDemand(store);
  const georeferencing = effective ? {
    hasGeoreference: effective.hasGeoreference,
    mapConversion: effective.mapConversion,
    projectedCRS: effective.projectedCRS,
    source: effective.source,
    transformMatrix: effective.mapConversion ? computeTransformMatrix(effective.mapConversion) : effective.transformMatrix,
  } : original;
  const value: RoomSpatialContext = { version: 1, georeferencing, coordinateInfo: frame, lengthUnitScale: getIfcLengthUnitScale(store) };
  // Validate before stringify, which otherwise converts non-finite numbers into null.
  decodeRoomSpatialContext(value);
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/** STEP resource ids have no counterpart in a root-only room snapshot. */
export function roomGeoreference(georef: GeoreferenceInfo | null): GeoreferenceInfo | null {
  return georef ? {
    ...georef,
    mapConversion: georef.mapConversion ? { ...georef.mapConversion, id: 0, sourceCRS: 0, targetCRS: 0 } : undefined,
    projectedCRS: georef.projectedCRS ? { ...georef.projectedCRS, id: 0 } : undefined,
  } : null;
}

/** Restore format-independent facts before registering the reconstructed model. */
export function restoreRoomSpatialFacts(store: IfcDataStore, context: RoomSpatialContext): void {
  const previous = extractGeoreferencingOnDemand(store);
  const georef = roomGeoreference(structuredClone(context.georeferencing));
  // Only a native store can prove these ids still refer to its resource rows.
  // Dense recipient stores keep zero ids even when a source blob is attached.
  if (georef?.mapConversion && previous?.mapConversion
    && ['IfcMapConversion', 'IfcMapConversionScaled'].includes(store.entities.getTypeName(previous.mapConversion.id))) {
    georef.mapConversion.id = previous.mapConversion.id;
    georef.mapConversion.sourceCRS = previous.mapConversion.sourceCRS;
    georef.mapConversion.targetCRS = previous.mapConversion.targetCRS;
  }
  if (georef?.projectedCRS && previous?.projectedCRS
    && store.entities.getTypeName(previous.projectedCRS.id) === 'IfcProjectedCRS') {
    georef.projectedCRS.id = previous.projectedCRS.id;
  }
  store.georeferencing = georef;
  store.lengthUnitScale = context.lengthUnitScale;
}

export function applyRoomSpatialContext(payload: ViewerModelPayload, slot: ModelSlot, notify: (message: string) => void): void {
  try {
    const decoded = decodeRoomSpatialContext(slot.spatialContext);
    const context = decoded ? structuredClone(decoded) : undefined;
    if (!context) return;
    restoreRoomSpatialFacts(payload.dataStore, context);
    if (context.coordinateInfo) payload.geometryResult.coordinateInfo = context.coordinateInfo;
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error));
  }
}
