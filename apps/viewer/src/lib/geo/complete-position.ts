/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A map position the file does not already carry as an IfcMapConversion is written by the export as a NEW conversion, and
 * a new conversion needs Eastings, Northings and OrthogonalHeight: the exporter refuses a partial one rather than invent
 * the rest. The viewer shows a missing coordinate as 0 everywhere (`mergeMapConversion`), so the edit that leaves one
 * missing stores that 0 itself, where the user sees it, can undo it and collaborators receive it like any other field.
 */
import { extractGeoreferencingOnDemand, type IfcDataStore, type MapConversion } from '@ifc-lite/parser';

export type PositionField = 'eastings' | 'northings' | 'orthogonalHeight';
const POSITION: readonly PositionField[] = ['eastings', 'northings', 'orthogonalHeight'];
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The position fields a pending edit must also carry: a source projected conversion's values, else explicit 0s.
 * IfcSite fallback coordinates are angular and its elevation is in project units, not necessarily the target map unit;
 * none can safely supply projected defaults. An edit needs it when it edits the conversion, or creates a CRS (the file has no
 * IfcProjectedCRS record, so the export writes one and a CRS is written with its position). Nothing when the file holds
 * the conversion as an IfcMapConversion record (the export edits that record in place) or the position is complete.
 */
export type PendingGeoref = { mapConversion?: Partial<MapConversion>; projectedCRS?: object };

export function positionCompletion(
  dataStore: IfcDataStore | null | undefined,
  pending: PendingGeoref | undefined,
  view?: { isDeleted(id: number): boolean },
  options: { inheritSourcePosition?: boolean } = {},
): Array<{ field: PositionField; value: number }> {
  const mc = pending?.mapConversion;
  const editsConversion = !!mc && Object.keys(mc).length > 0;
  const createsCrs = !!pending?.projectedCRS && Object.keys(pending.projectedCRS).length > 0;
  if (!editsConversion && !createsCrs) return [];
  const missing = POSITION.filter((k) => !finite(mc?.[k]));
  if (missing.length === 0) return [];
  const file = dataStore ? extractGeoreferencingOnDemand(dataStore) : null;
  if (options.inheritSourcePosition !== false && file?.source === 'mapConversion' && file.mapConversion && !view?.isDeleted(file.mapConversion.id)) return [];
  // Only a surviving source CRS can be updated by the export's source-record path.
  // @raw-entity-enumeration-ok cached source-class membership for export planning; exclude tombstones so a deleted CRS gets a complete replacement position.
  const hasSourceCrs = dataStore?.entityIndex?.byType.get('IFCPROJECTEDCRS')?.some((id) => !view?.isDeleted(id));
  if (!editsConversion && hasSourceCrs) return [];
  const projected = options.inheritSourcePosition !== false && (file?.source === 'mapConversion' || file?.source === 'ePSetMapConversion')
    ? file.mapConversion : undefined;
  return missing.map((k) => ({ field: k, value: finite(projected?.[k]) ? projected[k] : 0 }));
}

/** Whether this model's pending edit has no complete position (what taking one change back out of order can leave). */
export function leavesPartialPosition(
  state: { georefMutations: ReadonlyMap<string, PendingGeoref>; models: ReadonlyMap<string, { ifcDataStore?: IfcDataStore | null }>; mutationViews?: ReadonlyMap<string, { isDeleted(id: number): boolean }> },
  modelId: string,
): boolean {
  return positionCompletion(state.models.get(modelId)?.ifcDataStore, state.georefMutations.get(modelId), state.mutationViews?.get(modelId)).length > 0;
}
