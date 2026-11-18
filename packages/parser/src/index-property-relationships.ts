/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { RelationshipType, type RelationshipGraphBuilder } from '@ifc-lite/data';
import type { EntityRef } from './types.js';
import { extractPropertyRelFast } from './columnar-parser-relationships.js';
import { indexTypeRelationship, type SelectionRelationshipIndex } from './selection-relationship-index.js';

/** Index definitions once, while source is resident in the parser worker.
 * This same pass used to run after spatial-ready. Early type lookups need its
 * graph edges; retaining the pass here avoids any source sweep on selection. */
export async function indexPropertyRelationships(bytes: Uint8Array, refs: EntityRef[], containers: EntityRef[],
  graph: RelationshipGraphBuilder, typeIds: ReadonlySet<number>, index: SelectionRelationshipIndex, yieldIfNeeded: () => Promise<void>) {
  const propertySetIds = new Set<number>(), quantitySetIds = new Set<number>();
  for (const ref of containers) {
    if (ref.type.toUpperCase() === 'IFCPROPERTYSET') propertySetIds.add(ref.expressId);
    else if (ref.type.toUpperCase() === 'IFCELEMENTQUANTITY') quantitySetIds.add(ref.expressId);
  }
  const onDemandPropertyMap = new Map<number, number[]>(), onDemandQuantityMap = new Map<number, number[]>();
  for (let i = 0; i < refs.length; i++) {
    if ((i & 0x3ff) === 0) await yieldIfNeeded();
    const ref = refs[i], result = extractPropertyRelFast(bytes, ref.byteOffset, ref.byteLength);
    indexTypeRelationship(index, ref.expressId, result?.relatedObjects, result?.relatingDefs,
      result?.relatingDefs.every(id => propertySetIds.has(id) || quantitySetIds.has(id)));
    if (!result) continue;
    for (const member of new Set(result.relatedObjects)) if (typeIds.has(member)) {
      const rows = index.typeDefinitions.get(member) ?? [];
      rows.push(ref.expressId); index.typeDefinitions.set(member, rows);
    }
    for (const target of result.relatingDefs) {
      const map = propertySetIds.has(target) ? onDemandPropertyMap : quantitySetIds.has(target) ? onDemandQuantityMap : null;
      for (const member of result.relatedObjects) {
        graph.addEdge(target, member, RelationshipType.DefinesByProperties, ref.expressId);
        if (map) {
          const list = map.get(member) ?? [];
          if (!list.includes(target)) list.push(target);
          map.set(member, list);
        }
      }
    }
  }
  return { onDemandPropertyMap, onDemandQuantityMap };
}
