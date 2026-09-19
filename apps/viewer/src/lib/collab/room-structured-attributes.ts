/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcAttributeValue } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { decodeRoomAttributeValue } from './entity-reference-wire.js';
import { attributeNamesForStore } from './schema-attribute-names.js';

interface StructuredEntity {
  attributes?: Readonly<Record<string, unknown>>;
}

/** Restore CRDT attributes onto an IFCX store's otherwise-empty positional entity rows. */
export function hydrateStructuredEntityAttributes(
  store: IfcDataStore,
  pathToId: ReadonlyMap<string, number>,
  structuredForPath: (path: string) => StructuredEntity | undefined,
): string[] {
  const baseGetEntity = store.getEntity.bind(store);
  const baseGetEntitiesByType = store.getEntitiesByType.bind(store);
  const hydrated = new Map<number, IfcAttributeValue[]>();
  const diagnostics: string[] = [];
  for (const [path, expressId] of pathToId) {
    const base = baseGetEntity(expressId);
    const structured = structuredForPath(path);
    if (!base || !structured?.attributes) continue;
    const names = attributeNamesForStore(store, base.type);
    const values: IfcAttributeValue[] = Array.from({ length: names.length }, () => null);
    for (const [key, value] of Object.entries(structured.attributes)) {
      if (!key.startsWith('bsi::ifc::prop::')) continue;
      const name = key.slice('bsi::ifc::prop::'.length);
      const index = names.indexOf(name);
      if (index < 0) continue;
      const decoded = decodeRoomAttributeValue(store, value);
      if (!decoded.ok) {
        diagnostics.push(`${path}.${name}: ${decoded.reason}`);
        continue;
      }
      values[index] = decoded.value as IfcAttributeValue;
    }
    hydrated.set(expressId, values);
  }
  store.getEntity = (expressId) => {
    const base = baseGetEntity(expressId);
    const attributes = hydrated.get(expressId);
    return base && attributes ? { ...base, attributes } : base;
  };
  store.getEntitiesByType = (typeName) => baseGetEntitiesByType(typeName).map((base) => {
    const attributes = hydrated.get(base.expressId);
    return attributes ? { ...base, attributes } : base;
  });
  return diagnostics;
}
