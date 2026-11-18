/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { extractTypePropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';
import { readRelatedLists } from '@ifc-lite/create';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { effectivePropertySets } from './effectiveSets';

/**
 * The type relationships as they are now. With an overlay over a file's own
 * bytes this is the live list (file and session together), so a type assigned,
 * swapped or removed this session counts. Null when only the parsed
 * relationship graph can answer (no overlay, or a store without source bytes).
 */
function liveTypeLists(store: IfcDataStore, view: MutablePropertyView | null | undefined) {
  return view && store.source?.length ? readRelatedLists(store, 'IfcRelDefinesByType', view) : null;
}

/** The occurrences `typeId` types now (#9296: a type made this session has none in the parsed graph). */
export function liveTypeOccurrences(store: IfcDataStore, view: MutablePropertyView | null | undefined, typeId: number): number[] {
  const live = liveTypeLists(store, view);
  if (!live) return store.relationships?.getRelated(typeId, RelationshipType.DefinesByType, 'forward') ?? [];
  return [...new Set(live.filter(rel => rel.relatingId === typeId).flatMap(rel => rel.relatedIds))];
}

/** The panel and Assistant read the same inherited sets, including type edits.
 * An empty mutation view is authoritative: deletion must never revive loaded sets.
 * Keep occurrence values separate; a same-named occurrence property overrides the
 * type for that occurrence, without erasing the type's own definition (#7104).
 */
export function effectiveTypeProperties(
  store: IfcDataStore | null | undefined,
  expressId: number,
  view: MutablePropertyView | null | undefined,
) {
  if (!store) return null;
  const baseId = view?.resolveBaseEntityId(expressId) ?? expressId;
  const fromFile = extractTypePropertiesOnDemand(store, baseId);
  const live = liveTypeLists(store, view);
  // A copy of a loaded element reads its source's type until it is typed itself.
  const typed = (id: number) => live?.find(rel => rel.relatedIds.includes(id))?.relatingId;
  const liveTypeId = live ? typed(expressId) ?? typed(baseId) : undefined;
  if (live && liveTypeId === undefined) return null;
  // The file's sets belong to the file's type: a type assigned this session reads its own.
  const loaded = liveTypeId === undefined || fromFile?.typeId === liveTypeId ? fromFile : null;
  // The extractor returns null when the type has no loaded sets; a user can
  // still add its first set this session. Resolve the same native relationship.
  const typeId = liveTypeId ?? loaded?.typeId ?? store.relationships?.getRelated(baseId, RelationshipType.DefinesByType, 'inverse')[0];
  if (typeId === undefined) return null;
  const created = view?.getNewEntity(typeId);
  const createdName = created?.attributes[2];
  const result = loaded ?? { typeId, typeName: typeof createdName === 'string' && createdName !== '$' ? createdName : store.entities.getName(typeId),
    properties: !store.source?.length ? store.properties?.getForEntity(typeId) ?? [] : [],
  };
  const mutations = view?.getMutationsForEntity(result.typeId) ?? [];
  const mutatedKeys = new Map<string, Set<string>>();
  const newPsetNames = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.psetName && mutation.propName) {
      const names = mutatedKeys.get(mutation.psetName) ?? new Set<string>();
      names.add(mutation.propName);
      mutatedKeys.set(mutation.psetName, names);
    }
    if (mutation.psetName && (mutation.type === 'CREATE_PROPERTY_SET'
      || (mutation.type === 'CREATE_PROPERTY' && !result.properties.some(pset => pset.name === mutation.psetName)))) {
      newPsetNames.add(mutation.psetName);
    }
  }
  const psets = effectivePropertySets(view, result.typeId, () => result.properties);
  const editedName = view?.getAttributeMutationsForEntity(result.typeId).find(attr => attr.name === 'Name')?.value;
  return {
    typeName: typeof editedName === 'string' ? (editedName === '$' ? '' : editedName) : result.typeName,
    typeId: result.typeId,
    /** The type's IFC class, read off the overlay for a type made this session. */
    typeEntityName: created?.type ?? store.entities.getTypeName(result.typeId),
    psets: psets.map(pset => ({
      ...pset,
      properties: pset.properties.map(property => ({ ...property,
        isMutated: mutatedKeys.get(pset.name)?.has(property.name) ?? false,
      })),
      isNewPset: newPsetNames.has(pset.name),
    })),
  };
}
