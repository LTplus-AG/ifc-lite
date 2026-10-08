/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { extractTypePropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { effectivePropertySets } from './effectiveSets';

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
  const loaded = extractTypePropertiesOnDemand(store, baseId);
  // The extractor returns null when the type has no loaded sets; a user can
  // still add its first set this session. Resolve the same native relationship.
  const typeId = loaded?.typeId ?? store.relationships?.getRelated(baseId, RelationshipType.DefinesByType, 'inverse')[0];
  if (typeId === undefined) return null;
  const result = loaded ?? { typeId, typeName: store.entities.getName(typeId),
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
    psets: psets.map(pset => ({
      ...pset,
      properties: pset.properties.map(property => ({ ...property,
        isMutated: mutatedKeys.get(pset.name)?.has(property.name) ?? false,
      })),
      isNewPset: newPsetNames.has(pset.name),
    })),
  };
}
