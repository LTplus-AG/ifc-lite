/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DataModel } from '@ifc-lite/server-client';
import { REL_TYPE_MAP, SECONDARY_REL_TYPE_MAP } from '@ifc-lite/parser';
import { RelationshipGraphBuilder, type RelationshipGraph } from '@ifc-lite/data';

export interface ServerQuantitySet {
  qset_id: number;
  qset_name: string;
  method_of_measurement?: string;
  quantities: Array<{
    quantity_name: string;
    quantity_value: number;
    quantity_type: string;
  }>;
}

/** Build the graph and property/quantity mappings from a server data model. */
export function buildRelationships(dataModel: DataModel): {
  relationships: RelationshipGraph;
  entityToPsets: Map<number, Array<any>>;
  entityToQsets: Map<number, Array<ServerQuantitySet>>;
} {
  // The real CSR builder keeps server-loaded traversal/export semantics equal
  // to the local parser, including repeated relationship records (#3827).
  const graphBuilder = new RelationshipGraphBuilder();
  const entityToPsets = new Map<number, Array<any>>();
  const entityToQsets = new Map<number, Array<ServerQuantitySet>>();
  const typeOwnPsets = new Map<number, Array<any>>();
  const typeOwnQsets = new Map<number, Array<ServerQuantitySet>>();
  const unmappedRelTypes = new Set<string>();
  let sawRelId = false;

  for (const rel of dataModel.relationships) {
    const upperType = rel.rel_type.toUpperCase();
    const relType = REL_TYPE_MAP[upperType];

    if (upperType === 'IFCRELDEFINESBYPROPERTIES' || upperType === 'TYPEHASPROPERTYSETS') {
      const psetTarget = upperType === 'TYPEHASPROPERTYSETS' ? typeOwnPsets : entityToPsets;
      const qsetTarget = upperType === 'TYPEHASPROPERTYSETS' ? typeOwnQsets : entityToQsets;
      const pset = dataModel.propertySets.get(rel.relating_id);
      if (pset) {
        if (!psetTarget.has(rel.related_id)) psetTarget.set(rel.related_id, []);
        psetTarget.get(rel.related_id)!.push(pset);
      }
      const qset = (dataModel as { quantitySets?: Map<number, ServerQuantitySet> }).quantitySets?.get(rel.relating_id);
      if (qset) {
        if (!qsetTarget.has(rel.related_id)) qsetTarget.set(rel.related_id, []);
        qsetTarget.get(rel.related_id)!.push(qset);
      }
      if (upperType === 'TYPEHASPROPERTYSETS') continue;
    }

    if (relType === undefined) {
      if (!unmappedRelTypes.has(upperType)) {
        unmappedRelTypes.add(upperType);
        console.debug(`[serverDataModel] Unmapped relationship type: ${rel.rel_type}`);
      }
      continue;
    }

    if (rel.rel_id !== undefined) sawRelId = true;
    graphBuilder.addEdge(rel.relating_id, rel.related_id, relType, rel.rel_id ?? 0);
    const secondaryRelType = SECONDARY_REL_TYPE_MAP[upperType];
    if (secondaryRelType !== undefined) {
      graphBuilder.addEdge(rel.relating_id, rel.related_id, secondaryRelType, rel.rel_id ?? 0);
    }
  }

  if (unmappedRelTypes.size > 0) {
    console.warn(`[serverDataModel] Found ${unmappedRelTypes.size} unmapped relationship types: ${Array.from(unmappedRelTypes).join(', ')}`);
  }
  if (!sawRelId && dataModel.relationships.length > 0) {
    console.warn(
      `[serverDataModel] Server sent no rel_id column: all ${dataModel.relationships.length} relationship(s) get id 0. Exported RelId will be 0 — the server predates the data-model v6 payload.`,
    );
  }

  const mergeOwnFirst = <T extends { pset_name?: string; qset_name?: string }>(
    own: Map<number, T[]>, target: Map<number, T[]>, nameOf: (set: T) => string,
  ) => {
    for (const [typeId, ownSets] of own) {
      const seen = new Set(ownSets.map(nameOf));
      const rest = (target.get(typeId) ?? []).filter((set) => !seen.has(nameOf(set)));
      target.set(typeId, [...ownSets, ...rest]);
    }
  };
  mergeOwnFirst(typeOwnPsets, entityToPsets, (set) => set.pset_name ?? '');
  mergeOwnFirst(typeOwnQsets, entityToQsets, (set) => set.qset_name ?? '');

  return { relationships: graphBuilder.build(), entityToPsets, entityToQsets };
}
