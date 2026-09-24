/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcPropertyReferenceValue` reads as the referenced object's `Name`
 * (#5475, maintainer decision on #5226): the material, person, document,
 * library or classification reference, table row, … that the property
 * points at. An external reference without a `Name` falls back to its
 * `Identification`. A reference that resolves to neither keeps the `#<id>`
 * placeholder it always showed, so the property still reads as present.
 */

import type { EntityExtractor } from './entity-extractor.js';
import type { IfcDataStore } from './columnar-parser.js';
import type { IfcEntity } from './types.js';
import { getAttributeNamesAcrossSchemas } from './ifc-schema.js';
import type { ParsedIfcPropertyValue } from './property-value-parser.js';

/** EXPRESS attributes read, in order of preference. */
const LABEL_ATTRIBUTES = ['Name', 'Identification'] as const;

/** `[Name, Description, UsageName, PropertyReference]` in IFC2X3, IFC4 and IFC4X3 alike: the reference is slot 3. */
const PROPERTY_REFERENCE_SLOT = 3;

function referencedLabel(store: IfcDataStore, extractor: EntityExtractor, refId: number): string | undefined {
  const ref = store.entityIndex.byId.get(refId) ?? store.deferredEntityIndex?.get(refId);
  if (!ref) return undefined;
  const entity = extractor.extractEntity(ref);
  if (!entity) return undefined;
  const names = getAttributeNamesAcrossSchemas(entity.type);
  for (const wanted of LABEL_ATTRIBUTES) {
    const index = names.indexOf(wanted);
    const value = index >= 0 ? entity.attributes?.[index] : undefined;
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** Decode an `IfcPropertyReferenceValue` whose target can be resolved in `store`. */
export function resolvePropertyReferenceValue(
  store: IfcDataStore,
  extractor: EntityExtractor,
  propEntity: IfcEntity,
): ParsedIfcPropertyValue {
  const refId = propEntity.attributes?.[PROPERTY_REFERENCE_SLOT];
  if (typeof refId !== 'number') return { type: 0, value: null, structure: 'reference' };
  const label = referencedLabel(store, extractor, refId);
  return { type: 0, value: label ?? `#${refId}`, structure: 'reference' };
}
