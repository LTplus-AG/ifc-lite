/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store adapter for `checkStructuralConsistency`. Reads the parsed file;
 * edits held in a mutation view are not applied.
 */

import { exactTypeName } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { extractTypePropertiesOnDemand } from './on-demand-extractors.js';
import { mergeInheritedPropertySets } from './property-set-merge.js';
import { expandTypes } from './query-backend-maps.js';
import {
  checkStructuralConsistency,
  hasAnalyticalModel,
  LOAD_BEARING_CLASSES,
  type PhysicalElementFact,
  type StructuralConsistencyIssue,
  type StructuralConsistencyOptions,
} from './structural-consistency.js';
import { structuralCounterparts } from './structural-counterparts.js';
import { extractStructuralOnDemand } from './structural-extractor.js';
import type { StructuralExtraction } from './structural-types.js';

type NamedPset = { name: string; properties: ReadonlyArray<{ name: string; value: unknown }> };

/**
 * `LoadBearing` from any `Pset_*Common`. The occurrence's sets come first in
 * the merge, so the first value found wins over the type's; a non-boolean
 * winner (IfcLogical UNKNOWN) counts as unstated.
 */
function loadBearing(store: IfcDataStore, expressId: number): boolean | undefined {
  const psets = mergeInheritedPropertySets<NamedPset>(store.getProperties(expressId), extractTypePropertiesOnDemand(store, expressId)?.properties ?? []);
  for (const pset of psets) {
    const name = pset.name.toLowerCase();
    if (!name.startsWith('pset_') || !name.endsWith('common')) continue;
    const property = pset.properties.find((candidate) => candidate.name === 'LoadBearing');
    if (property) return typeof property.value === 'boolean' ? property.value : undefined;
  }
  return undefined;
}

/**
 * Every element of a load-bearing class, subtypes included, per the file's
 * schema. These classes cover every class the mismatch rule names too.
 * LoadBearing is read only for elements with no structural item: no rule
 * reads it for the others.
 */
export function structuralConsistencyFacts(store: IfcDataStore, structural: StructuralExtraction): PhysicalElementFact[] {
  const ids = new Set<number>();
  for (const type of expandTypes(LOAD_BEARING_CLASSES.map((name) => name.toUpperCase()), store.schemaVersion)) {
    // @raw-entity-enumeration-ok the checks read the parsed file, as `ifc-lite validate` does
    for (const id of store.entityIndex.byType.get(type) ?? []) ids.add(id);
  }

  const facts: PhysicalElementFact[] = [];
  for (const expressId of [...ids].sort((a, b) => a - b)) {
    const stated = structuralCounterparts(structural, expressId) ? undefined : loadBearing(store, expressId);
    facts.push({
      expressId,
      globalId: store.entities.getGlobalId(expressId),
      type: exactTypeName(store.entities, expressId),
      ...(stated === undefined ? {} : { loadBearing: stated }),
    });
  }
  return facts;
}

/** The consistency issues of a parsed file. Physical elements are read only when rule 1 or 3 can use them. */
export function structuralConsistencyIssues(store: IfcDataStore, options?: StructuralConsistencyOptions): StructuralConsistencyIssue[] {
  const structural = extractStructuralOnDemand(store);
  return checkStructuralConsistency(structural, hasAnalyticalModel(structural) ? structuralConsistencyFacts(store, structural) : [], options);
}
