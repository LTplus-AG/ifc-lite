/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the loaded schema says an entity attribute IS, for the chart field
 * picker (#4833). A STEP attribute slot holds a plain number both for a
 * measure (`OverallHeight = 2100.`) and for an entity reference (`Axis = #21`);
 * only the EXPRESS declaration tells them apart. The picker offers an
 * attribute only when its declared type is a scalar (a simple type, a defined
 * type, an enumeration, or a select that admits at least one non-entity
 * member) — a reference or a collection is not a value anyone can chart.
 */
import type { IfcDataStore, SchemaRegistry } from '@ifc-lite/parser';
import { getAttributeNamesAcrossSchemas, getSchemaRegistryForVersion } from '@ifc-lite/parser';

type AttributeMetadata = NonNullable<SchemaRegistry['entities'][string]['allAttributes']>[number];

export interface ElementAttributeSchema {
  /** Every attribute name the schema declares for this entity type (inherited included). */
  attributeNames(typeName: string): readonly string[];
  /** The declared EXPRESS type of one attribute, `undefined` when the schema has no entry. */
  attributeType(typeName: string, attributeName: string): string | undefined;
  /** True only for an attribute whose declared type is a single scalar value. */
  isScalarAttribute(typeName: string, attributeName: string): boolean;
}

/** Whether `typeName` denotes only entity instances (an entity or a select of entities). */
function isReferenceType(registry: SchemaRegistry, typeName: string, visited = new Set<string>()): boolean {
  if (visited.has(typeName)) return true;
  visited.add(typeName);
  if (registry.entities[typeName]) return true;
  const members = registry.selects[typeName];
  if (members) return members.every((member) => isReferenceType(registry, member, visited));
  return false;
}

export function createElementAttributeSchema(store: Pick<IfcDataStore, 'schemaVersion'>): ElementAttributeSchema {
  const registry: SchemaRegistry | undefined = store.schemaVersion === 'IFC5'
    ? undefined
    : getSchemaRegistryForVersion(store.schemaVersion);
  const byType = new Map<string, Map<string, AttributeMetadata>>();

  const metadataFor = (typeName: string): Map<string, AttributeMetadata> => {
    let attributes = byType.get(typeName);
    if (attributes) return attributes;
    const entity = registry?.entities[typeName]
      ?? Object.values(registry?.entities ?? {}).find((candidate) => candidate.name.toUpperCase() === typeName.toUpperCase());
    attributes = new Map((entity?.allAttributes ?? []).map((attribute) => [attribute.name, attribute]));
    byType.set(typeName, attributes);
    return attributes;
  };

  return {
    attributeNames(typeName) {
      const declared = metadataFor(typeName);
      return declared.size > 0 ? [...declared.keys()] : getAttributeNamesAcrossSchemas(typeName);
    },
    attributeType(typeName, attributeName) {
      return metadataFor(typeName).get(attributeName)?.type;
    },
    isScalarAttribute(typeName, attributeName) {
      const attribute = metadataFor(typeName).get(attributeName);
      // No declaration to consult: only a value the columnar table already
      // resolved as text can be trusted; a bare number might be a reference.
      if (!attribute || !registry) return false;
      if (attribute.isArray || attribute.isList || attribute.isSet) return false;
      return !isReferenceType(registry, attribute.type);
    },
  };
}
