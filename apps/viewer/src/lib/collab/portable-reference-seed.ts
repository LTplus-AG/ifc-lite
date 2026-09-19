/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CollabSession } from '@ifc-lite/collab';
import { getAttributeNamesAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
import type { CollabDocApi } from './mutation-bridge';
import { pathForEntity, pathForGuid, registerEntityPath } from './entity-paths';
import {
  explicitReferenceId,
  isPortableReferenceList,
  isPortableReferenceScalar,
  portableReferenceId,
} from './portable-reference-entities';

/** Materialize a newly referenced GUID-less source closure before publishing its path. */
export function seedReferencedSourceEntities(
  api: CollabDocApi,
  session: CollabSession,
  store: IfcDataStore,
  attrName: string,
  value: unknown,
): void {
  const roots = isPortableReferenceList(attrName) && Array.isArray(value)
    ? value.map(explicitReferenceId).filter((id): id is number => id !== null)
    : isPortableReferenceScalar(attrName)
      ? [explicitReferenceId(value)].filter((id): id is number => id !== null)
      : [];
  const visiting = new Set<number>();
  const seed = (id: number): string | null => {
    const existing = pathForEntity(store, id);
    if (existing && api.hasEntity(session.doc, existing)) return existing;
    if (visiting.has(id)) return existing;
    const entity = store.getEntity?.(id);
    if (!entity) return existing;
    visiting.add(id);
    const base = `ifc-lite-ref-${id}`;
    let key = base;
    let suffix = 0;
    while (store.entities.getExpressIdByGlobalId(key) >= 0) key = `${base}-${++suffix}`;
    const path = existing ?? pathForGuid(store, key);
    registerEntityPath(store, id, path);
    const names = getAttributeNamesAcrossSchemas(entity.type);
    const attributes: Record<string, unknown> = {
      'bsi::ifc::class': { code: entity.type },
    };
    entity.attributes.forEach((raw, index) => {
      const name = names[index];
      if (!name || raw === undefined) return;
      if (Array.isArray(raw)) {
        attributes[`bsi::ifc::prop::${name}`] = raw.map((member) => {
          const ref = portableReferenceId(store, entity.type, index, name, member);
          return ref === null ? member : seed(ref) ?? member;
        });
        return;
      }
      const ref = portableReferenceId(store, entity.type, index, name, raw);
      attributes[`bsi::ifc::prop::${name}`] = ref === null ? raw : seed(ref) ?? raw;
    });
    session.transact(() => api.createEntity(session.doc, path, { ifcClass: entity.type, attributes }));
    visiting.delete(id);
    return path;
  };
  for (const id of roots) seed(id);
}
