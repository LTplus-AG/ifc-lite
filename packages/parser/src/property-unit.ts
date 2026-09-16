/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from './columnar-parser.js';
import type { EntityExtractor } from './entity-extractor.js';
import { resolveUnitByRef } from './project-units.js';

/** Resolve the optional explicit Unit attribute shared by IFC property values. */
export function resolvePropertyUnit(
  store: IfcDataStore,
  extractor: EntityExtractor,
  propertyType: string,
  attributes: unknown[],
): string | undefined {
  const type = propertyType.toUpperCase();
  const unitIndex = type === 'IFCPROPERTYBOUNDEDVALUE' ? 4
    : type === 'IFCPROPERTYTABLEVALUE' ? 7
      : type === 'IFCPROPERTYSINGLEVALUE' || type === 'IFCPROPERTYLISTVALUE' ? 3 : -1;
  const unitRef = unitIndex >= 0 && typeof attributes[unitIndex] === 'number'
    ? attributes[unitIndex]
    : undefined;
  if (unitRef === undefined) return undefined;

  return resolveUnitByRef(extractor, {
    byId: { get: (id) => store.entityIndex.byId.get(id) ?? store.deferredEntityIndex?.get(id) },
  }, unitRef)?.resolved.symbol;
}
