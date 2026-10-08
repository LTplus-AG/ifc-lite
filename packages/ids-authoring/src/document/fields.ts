/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Constraint-bearing fields of IDS facets, addressed by a flat name
 * (`property.baseName`, `partOf.entity.name`, …) so ops, the gate and the
 * node index can talk about "a field" without per-facet switch statements.
 */

import type { FacetType, IDSConstraint, IDSEntityFacet, IDSFacet } from '@ifc-lite/ids';

export const FACET_FIELDS = {
  entity: ['entity.name', 'entity.predefinedType'],
  attribute: ['attribute.name', 'attribute.value'],
  property: ['property.propertySet', 'property.baseName', 'property.dataType', 'property.value'],
  classification: ['classification.system', 'classification.value'],
  material: ['material.value'],
  partOf: ['partOf.entity.name', 'partOf.entity.predefinedType'],
} as const satisfies Record<FacetType, readonly string[]>;

export type FacetFieldName = (typeof FACET_FIELDS)[FacetType][number];

export const ALL_FACET_FIELDS: readonly FacetFieldName[] = Object.values(FACET_FIELDS).flat();

/** Fields an IDS facet cannot exist without (IDS 1.0 XSD). */
export const REQUIRED_FIELDS: ReadonlySet<FacetFieldName> = new Set<FacetFieldName>([
  'entity.name',
  'attribute.name',
  'property.propertySet',
  'property.baseName',
  'partOf.entity.name',
]);

export function isFacetFieldName(value: unknown): value is FacetFieldName {
  return typeof value === 'string' && (ALL_FACET_FIELDS as readonly string[]).includes(value);
}

/** The facet type a field belongs to (`'property.value'` → `'property'`). */
export function facetTypeOfField(field: FacetFieldName): FacetType {
  return field.slice(0, field.indexOf('.')) as FacetType;
}

export function fieldBelongsTo(facet: IDSFacet, field: FacetFieldName): boolean {
  return facetTypeOfField(field) === facet.type;
}

export function getField(facet: IDSFacet, field: FacetFieldName): IDSConstraint | undefined {
  if (!fieldBelongsTo(facet, field)) return undefined;
  switch (facet.type) {
    case 'entity':
      return field === 'entity.name' ? facet.name : facet.predefinedType;
    case 'attribute':
      return field === 'attribute.name' ? facet.name : facet.value;
    case 'property':
      if (field === 'property.propertySet') return facet.propertySet;
      if (field === 'property.baseName') return facet.baseName;
      if (field === 'property.dataType') return facet.dataType;
      return facet.value;
    case 'classification':
      return field === 'classification.system' ? facet.system : facet.value;
    case 'material':
      return facet.value;
    case 'partOf':
      if (!facet.entity) return undefined;
      return field === 'partOf.entity.name' ? facet.entity.name : facet.entity.predefinedType;
  }
}

/** Fields currently carrying a constraint, in declaration order. */
export function presentFields(facet: IDSFacet): FacetFieldName[] {
  return FACET_FIELDS[facet.type].filter((f) => getField(facet, f) !== undefined);
}

/** Copy of `obj` with `key` set, or removed when `value` is undefined. */
function withKey<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): T {
  const next = { ...obj };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * Return a copy of `facet` with `field` set to `value` (or removed when
 * `value` is undefined). Throws on a field of another facet type, or on a
 * `partOf.entity.predefinedType` without a related entity — both are gate
 * errors (`GATE-STR-002`) that must never reach the reducer.
 */
export function setField(facet: IDSFacet, field: FacetFieldName, value: IDSConstraint | undefined): IDSFacet {
  if (!fieldBelongsTo(facet, field)) {
    throw new Error(`field ${field} does not belong to a ${facet.type} facet`);
  }
  const required = REQUIRED_FIELDS.has(field) && field !== 'partOf.entity.name';
  if (required && value === undefined) throw new Error(`field ${field} is required`);
  switch (facet.type) {
    case 'entity':
      return field === 'entity.name'
        ? { ...facet, name: value as IDSConstraint }
        : withKey(facet, 'predefinedType', value);
    case 'attribute':
      return field === 'attribute.name'
        ? { ...facet, name: value as IDSConstraint }
        : withKey(facet, 'value', value);
    case 'property':
      if (field === 'property.propertySet') return { ...facet, propertySet: value as IDSConstraint };
      if (field === 'property.baseName') return { ...facet, baseName: value as IDSConstraint };
      return withKey(facet, field === 'property.dataType' ? 'dataType' : 'value', value);
    case 'classification':
      return withKey(facet, field === 'classification.system' ? 'system' : 'value', value);
    case 'material':
      return withKey(facet, 'value', value);
    case 'partOf': {
      if (field === 'partOf.entity.name') {
        if (value === undefined) return withKey(facet, 'entity', undefined);
        const entity: IDSEntityFacet = facet.entity
          ? { ...facet.entity, name: value }
          : { type: 'entity', name: value };
        return { ...facet, entity };
      }
      if (!facet.entity) throw new Error('partOf.entity.predefinedType needs partOf.entity.name');
      return { ...facet, entity: withKey(facet.entity, 'predefinedType', value) };
    }
  }
}
