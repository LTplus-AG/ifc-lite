/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A map position the file does not already carry as an IfcMapConversion is written by the export as a NEW conversion, and
 * a new conversion needs Eastings, Northings and OrthogonalHeight: the exporter refuses a partial one rather than invent
 * the rest. The viewer shows a missing coordinate as 0 everywhere (`mergeMapConversion`), so the edit that leaves one
 * missing stores that 0 itself, where the user sees it, can undo it and collaborators receive it like any other field.
 */
import { extractGeoreferencingOnDemand, type GeoreferenceInfo, type IfcDataStore, type MapConversion } from '@ifc-lite/parser';

export type PositionField = 'eastings' | 'northings' | 'orthogonalHeight';
const POSITION: readonly PositionField[] = ['eastings', 'northings', 'orthogonalHeight'];
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The position fields a pending conversion edit must also carry, with the value each takes: the file's own
 * (an ePSet or IfcSite reading it displays), else 0. Nothing when there is no edit, when the file holds the conversion as
 * an IfcMapConversion record (the export edits that record in place), or when the position is already complete.
 */
export function positionCompletion(
  readFile: () => Pick<GeoreferenceInfo, 'mapConversion' | 'source'> | null | undefined,
  pending: Partial<MapConversion> | undefined,
): Array<{ field: PositionField; value: number }> {
  if (!pending || Object.keys(pending).length === 0) return [];
  const missing = POSITION.filter((k) => !finite(pending[k]));
  if (missing.length === 0) return [];
  const file = readFile();
  if (file?.source === 'mapConversion') return [];
  return missing.map((k) => ({ field: k, value: finite(file?.mapConversion?.[k]) ? file.mapConversion[k] : 0 }));
}

/** Whether this model's pending conversion edit has no complete position (what taking one change back out of order can leave). */
export function leavesPartialPosition(
  state: { georefMutations: ReadonlyMap<string, { mapConversion?: Partial<MapConversion> }>; models: ReadonlyMap<string, { ifcDataStore?: IfcDataStore | null }> },
  modelId: string,
): boolean {
  const dataStore = state.models.get(modelId)?.ifcDataStore;
  return positionCompletion(() => (dataStore ? extractGeoreferencingOnDemand(dataStore) : null), state.georefMutations.get(modelId)?.mapConversion).length > 0;
}
