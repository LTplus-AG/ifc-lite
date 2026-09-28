/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { createElementFieldReader, type ElementFieldReader } from '@/lib/charts/element-field-reader';
import { effectiveScheduleGroups } from './effective-schedule-groups.js';
import type { GenerateScheduleOptions, GroupEntry } from './generate-schedule.js';

/** Resolve a spatial-container expressId → friendly name for the task label. */
function readAttribute(reader: ElementFieldReader | undefined, expressId: number, attributeName: string): unknown {
  return reader?.read(expressId, { kind: 'attribute', attributeName, valueKind: 'category' });
}

function resolveName(store: IfcDataStore, expressId: number, fallback: string, reader?: ElementFieldReader): string {
  const name = reader ? readAttribute(reader, expressId, 'Name') : store.entities?.getName?.(expressId);
  return typeof name === 'string' && name.length > 0 ? name : fallback;
}

/** Read the entry's elevation from the hierarchy. Falls back to 0 when absent. */
function storeyElevation(store: IfcDataStore, storeyId: number, view?: MutablePropertyView | null, reader?: ElementFieldReader): number {
  const scale = store.lengthUnitScale ?? 1;
  const edited = view?.getAttributeMutationsForEntity(storeyId).find((mutation) => mutation.name === 'Elevation')?.value;
  if (edited !== undefined && edited !== null && Number.isFinite(Number(edited))) return Number(edited) * scale;
  if (view?.getNewEntity(storeyId)) {
    const authored = readAttribute(reader, storeyId, 'Elevation');
    if (authored !== null && authored !== undefined && authored !== '' && Number.isFinite(Number(authored))) return Number(authored) * scale;
  }
  return store.spatialHierarchy?.storeyElevations?.get(storeyId) ?? 0;
}

export function collectSpatialScheduleContainers(
  store: IfcDataStore,
  options: GenerateScheduleOptions,
  mutationView?: MutablePropertyView | null,
): GroupEntry[] {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return [];

  let groups: Array<{ expressId: number; entry: GroupEntry; elevation: number }> = [];
  const view = mutationView?.hasPendingChanges() ? mutationView : undefined;
  const reader = view ? createElementFieldReader(store, view) : undefined;
  // With no queued edits, the parser's precomputed source groups are the effective groups.
  const members = view ? effectiveScheduleGroups(store, view, options.strategy === 'IfcBuildingStorey' ? 'IfcBuildingStorey' : 'IfcBuilding')
    : options.strategy === 'IfcBuildingStorey' ? hierarchy.byStorey : hierarchy.byBuilding;

  if (options.strategy === 'IfcBuildingStorey') {
    for (const [storeyId, elementIds] of members) {
      if (options.skipEmptyGroups && elementIds.length === 0) continue;
      groups.push({
        expressId: storeyId,
        entry: makeGroupEntry(store, storeyId, elementIds, 'Storey', reader),
        elevation: storeyElevation(store, storeyId, view, reader),
      });
    }
  } else {
    for (const [buildingId, elementIds] of members) {
      if (options.skipEmptyGroups && elementIds.length === 0) continue;
      groups.push({
        expressId: buildingId,
        entry: makeGroupEntry(store, buildingId, elementIds, 'Building', reader),
        elevation: 0,
      });
    }
  }

  // Deterministic ordering: bottom-up by elevation (storeys) / insertion
  // order (buildings); top-down reverses.
  groups.sort((a, b) => {
    if (options.strategy === 'IfcBuildingStorey') return a.elevation - b.elevation;
    return 0;
  });
  if (options.order === 'top-down') groups.reverse();

  return groups.map(g => g.entry);
}

function makeGroupEntry(
  store: IfcDataStore,
  containerId: number,
  elementIds: number[],
  fallbackPrefix: string,
  reader?: ElementFieldReader,
): GroupEntry {
  const name = resolveName(store, containerId, `${fallbackPrefix} #${containerId}`, reader);
  const containerGlobalId = reader ? readAttribute(reader, containerId, 'GlobalId') : store.entities?.getGlobalId?.(containerId);
  const productGlobalIds: string[] = new Array(elementIds.length);
  for (let i = 0; i < elementIds.length; i++) {
    const gid = reader ? readAttribute(reader, elementIds[i], 'GlobalId') : store.entities?.getGlobalId?.(elementIds[i]);
    productGlobalIds[i] = typeof gid === 'string' ? gid : '';
  }
  return {
    name,
    identification: undefined,
    description: undefined,
    productExpressIds: [...elementIds],
    productGlobalIds,
    // Always include the container's expressId so the seed is unique even
    // if two storeys happen to report the same IFC GlobalId (seen in the
    // wild with a malformed parser state — duplicates collapsed every
    // storey to the same task globalId and cross-mapped products into the
    // wrong task). expressId is authoritative per model; concatenating it
    // with the GlobalId keeps the seed human-readable for debugging.
    sourceGlobalId: `${typeof containerGlobalId === 'string' && containerGlobalId || fallbackPrefix}#${containerId}`,
  };
}
