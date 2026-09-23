/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IFC_ENTITY_NAMES } from '@ifc-lite/data';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { EntityExtractor, resolveEffectiveEntityRecord, type IfcDataStore } from '@ifc-lite/parser';

/** A canonical IFC class name for one effective STEP type. */
export function canonicalEffectiveType(type: string): string {
  return IFC_ENTITY_NAMES[type.toUpperCase()] ?? type;
}

function elevationInMetres(store: IfcDataStore, value: unknown, expressId: number): number | null {
  const raw = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Number(value)
    : value && typeof value === 'object' && 'real' in value && typeof value.real === 'number'
      ? value.real : undefined;
  return raw !== undefined && Number.isFinite(raw)
    ? raw * (store.lengthUnitScale ?? 1)
    : store.spatialHierarchy?.storeyElevations.get(expressId) ?? null;
}

/**
 * The visible storey label and elevation for a filter option. Unchanged source
 * rows stay on the parser's columns; edited and authored rows use the same
 * effective record that export writes.
 */
export function effectiveStoreyOption(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  expressId: number,
): [string, number | null] | null {
  const created = view?.getNewEntity(expressId);
  const retype = view?.getEntityTypeMutation(expressId)?.newType;
  const named = view?.getAttributeMutationsForEntity(expressId) ?? [];
  const positional = view?.getPositionalMutationsForEntity(expressId);
  if (!created && !retype && named.length === 0 && (!positional || positional.size === 0)) {
    const name = store.entities.getName(expressId);
    return name ? [name, store.spatialHierarchy?.storeyElevations.get(expressId) ?? null] : null;
  }

  // @raw-entity-enumeration-ok point lookup for an already-enumerated effective storey
  const ref = created ? undefined : store.entityIndex.byId.get(expressId)
    ?? store.deferredEntityIndex?.get(expressId);
  const source = ref && store.source?.length > 0
    ? new EntityExtractor(store.source).extractEntity(ref)
    : null;
  const entity = created ?? source;
  if (!entity) {
    // Server-hydrated stores can have columns but no resident STEP record.
    const editedName = positional?.get(2) ?? named.find(({ name }) => name === 'Name')?.value;
    const name = typeof editedName === 'string' ? editedName : store.entities.getName(expressId);
    if (!name?.trim()) return null;
    const editedElevation = positional?.get(9) ?? named.find(({ name }) => name === 'Elevation')?.value;
    return [name, elevationInMetres(store, editedElevation, expressId)];
  }
  const record = resolveEffectiveEntityRecord(entity, {
    retype,
    named: named.map(({ name, value }) => [name, value] as const),
    positional: positional ?? [],
  }, store.schemaVersion);
  const name = record.attributes[2];
  if (typeof name !== 'string' || !name.trim()) return null;
  // IfcBuildingStorey.Elevation is slot 9 in IFC2X3 and IFC4.
  return [name, elevationInMetres(store, record.attributes[9], expressId)];
}

/**
 * Sample the effective domain without letting a large source map starve late
 * overlay creations. Only the selected IDs pay for property/material reads.
 */
export function effectiveCandidateIds(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  sourceIds: Iterable<number> | undefined,
  cap: number,
): number[] {
  let out: number[] = [];
  let stride = 1;
  let seen = 0;
  for (const { expressId } of iterateEffectiveEntityIds(store, view, undefined, sourceIds)) {
    if (seen++ % stride !== 0) continue;
    out.push(expressId);
    if (out.length > cap) {
      out = out.filter((_, index) => index % 2 === 0);
      stride *= 2;
    }
  }
  return out;
}
