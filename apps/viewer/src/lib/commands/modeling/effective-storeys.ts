/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { EntityExtractor, resolveEffectiveEntityRecord, type IfcDataStore } from '@ifc-lite/parser';

/** Storeys available as authoring anchors in this model's live session. */
export function effectiveStoreyIds(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
): number[] {
  return Array.from(
    iterateEffectiveEntityIds(store, view, ['IFCBUILDINGSTOREY']),
    ({ expressId }) => expressId,
  );
}

/** Prefer a live selection, otherwise use the first available storey. */
export function selectEffectiveStoreyId(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  preferred: number | null,
): number | null {
  const ids = effectiveStoreyIds(store, view);
  return preferred !== null && ids.includes(preferred) ? preferred : ids[0] ?? null;
}

/** Renderer-frame floor height for a live storey, including authored Elevation. */
export function effectiveStoreyElevation(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  storeyId: number,
): number {
  const created = view?.getNewEntity(storeyId);
  const retype = view?.getEntityTypeMutation(storeyId)?.newType;
  const named = view?.getAttributeMutationsForEntity(storeyId) ?? [];
  const positional = view?.getPositionalMutationsForEntity(storeyId);
  // Hover raycasts ask for this floor repeatedly. The parsed hierarchy is
  // already in metres, so avoid extracting an unchanged source record.
  if (!created && !retype && !positional?.has(9)
    && !named.some(({ name }) => name === 'Elevation')) {
    return store.spatialHierarchy?.storeyElevations.get(storeyId) ?? 0;
  }
  // @raw-entity-enumeration-ok point lookup for the already-selected effective storey's source record
  const ref = created ? undefined : store.entityIndex.byId.get(storeyId)
    ?? store.deferredEntityIndex?.get(storeyId);
  const source = ref && store.source.byteLength > 0
    ? new EntityExtractor(store.source).extractEntity(ref)
    : null;
  const entity = created ?? source;
  if (entity) {
    const record = resolveEffectiveEntityRecord(entity, {
      retype,
      named: named.map(({ name, value }) => [name, value] as const),
      positional: positional ?? [],
    }, store.schemaVersion);
    const value = record.attributes[9]; // IfcBuildingStorey.Elevation in IFC2X3/IFC4.
    const raw = typeof value === 'number' ? value
      : typeof value === 'string' && value.trim() ? Number(value)
      : value && typeof value === 'object' && 'real' in value && typeof value.real === 'number'
        ? value.real
        : Array.isArray(value) && typeof value[1] === 'number' ? value[1] : undefined;
    if (raw !== undefined && Number.isFinite(raw)) return raw * (store.lengthUnitScale ?? 1);
  }
  // The parsed hierarchy also includes ObjectPlacement-Z when Elevation is null.
  return store.spatialHierarchy?.storeyElevations.get(storeyId) ?? 0;
}
