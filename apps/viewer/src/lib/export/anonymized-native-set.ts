/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { RelatedEntities } from '@ifc-lite/export';
/** Locked spatial context is shared by the interactive preview and automation. */
export function lockedAnonymizedIds(related: RelatedEntities | null, seeds: readonly number[]) {
  const locked = new Set(seeds);
  for (const group of related?.groups ?? []) {
    if (group.relationship !== 'IfcRelContainedInSpatialStructure' || group.role !== 'container') {
      if (group.relationship !== 'IfcRelAggregates' || group.role !== 'spatial ancestor') continue;
    }
    for (const id of group.expressIds) locked.add(id);
    for (const id of group.relationshipIds) locked.add(id);
  }
  return locked;
}
export function includedAnonymizedIds(related: RelatedEntities | null, lockedIds: ReadonlySet<number>, excludedIds: ReadonlySet<number>, excludedTypes: ReadonlySet<string>, typeOfId: ReadonlyMap<number, string>) {
  const out = new Set<number>();
  for (const id of related?.all ?? []) {
    if (excludedIds.has(id)) continue;
    const typeName = typeOfId.get(id);
    if (typeName !== undefined && excludedTypes.has(typeName) && !lockedIds.has(id)) continue;
    out.add(id);
  }
  return out;
}
