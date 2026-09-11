/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Untranslated English formatting for a failed facet check and for a
 * requirement's plain-language description. Split out of `validator.ts`
 * to keep that module under this package's line-count budget — these
 * two functions are pure string formatting with no validation logic.
 */

import type { IDSRequirement } from '../types.js';
import { formatConstraint } from '../constraints/index.js';
import type { FacetCheckResult } from '../facets/index.js';

/**
 * Format a failure reason without translation
 */
export function formatFailureReason(result: FacetCheckResult): string {
  if (!result.failure) {
    return `Expected ${result.expectedValue}, got ${result.actualValue}`;
  }

  const { type, field, actual, expected } = result.failure;

  switch (type) {
    case 'ENTITY_TYPE_MISMATCH':
      return `Entity type "${actual}" does not match expected ${expected}`;
    case 'PREDEFINED_TYPE_MISMATCH':
      return `Predefined type "${actual}" does not match expected ${expected}`;
    case 'PREDEFINED_TYPE_MISSING':
      return `Predefined type is missing, expected ${expected}`;
    case 'ATTRIBUTE_MISSING':
      return `Attribute "${field}" is missing`;
    case 'ATTRIBUTE_VALUE_MISMATCH':
      return `Attribute "${field}" value "${actual}" does not match expected ${expected}`;
    case 'ATTRIBUTE_PATTERN_MISMATCH':
      return `Attribute "${field}" value "${actual}" does not match pattern ${expected}`;
    case 'PSET_MISSING':
      return `Property set "${field || expected}" not found`;
    case 'PROPERTY_MISSING':
      return `Property "${field}" not found`;
    case 'PROPERTY_VALUE_MISMATCH':
      return `Property "${field}" value "${actual}" does not match expected ${expected}`;
    case 'PROPERTY_DATATYPE_MISMATCH':
      return `Property "${field}" type "${actual}" does not match expected ${expected}`;
    case 'PROPERTY_OUT_OF_BOUNDS':
      return `Property "${field}" value ${actual} is out of bounds ${expected}`;
    case 'CLASSIFICATION_MISSING':
      return 'No classification found';
    case 'CLASSIFICATION_SYSTEM_MISMATCH':
      return `Classification system "${actual}" does not match expected ${expected}`;
    case 'CLASSIFICATION_VALUE_MISMATCH':
      return `Classification value "${actual}" does not match expected ${expected}`;
    case 'CLASSIFICATION_UNRESOLVED':
      return field === 'presence' ? 'Whether this entity is classified cannot be determined from this data source' : 'Entity is classified, but classification details cannot be read from this data source';
    case 'MATERIAL_MISSING':
      return 'No material assigned';
    case 'MATERIAL_VALUE_MISMATCH':
      return `Material "${actual}" does not match expected ${expected}`;
    case 'PARTOF_RELATION_MISSING':
      return `Not ${field} any entity`;
    case 'PARTOF_ENTITY_MISMATCH':
      return `Parent entity "${actual}" does not match expected ${expected}`;
    case 'PARTOF_PREDEFINED_TYPE_MISSING':
      return `Parent entity predefined type is missing, expected ${expected}`;
    case 'PARTOF_PREDEFINED_TYPE_MISMATCH':
      return `Parent entity predefined type "${actual}" does not match expected ${expected}`;
    default:
      return `Validation failed: ${type}`;
  }
}

/** Format a requirement description without translation */
export function formatRequirementDescription(requirement: IDSRequirement): string {
  const facet = requirement.facet;
  const optionality = requirement.optionality;

  let desc: string;

  switch (facet.type) {
    case 'entity':
      desc = `Must be ${formatConstraint(facet.name)}`;
      if (facet.predefinedType) {
        desc += ` with predefinedType ${formatConstraint(facet.predefinedType)}`;
      }
      break;

    case 'attribute':
      if (facet.value) {
        desc = `Attribute "${formatConstraint(facet.name)}" must equal ${formatConstraint(facet.value)}`;
      } else {
        desc = `Attribute "${formatConstraint(facet.name)}" must exist`;
      }
      break;

    case 'property':
      if (facet.value) {
        desc = `Property "${formatConstraint(facet.propertySet)}.${formatConstraint(facet.baseName)}" must equal ${formatConstraint(facet.value)}`;
      } else {
        desc = `Property "${formatConstraint(facet.propertySet)}.${formatConstraint(facet.baseName)}" must exist`;
      }
      break;

    case 'classification':
      if (facet.system && facet.value) {
        desc = `Must have classification ${formatConstraint(facet.value)} in ${formatConstraint(facet.system)}`;
      } else if (facet.system) {
        desc = `Must be classified in ${formatConstraint(facet.system)}`;
      } else if (facet.value) {
        desc = `Must have classification ${formatConstraint(facet.value)}`;
      } else {
        desc = 'Must have a classification';
      }
      break;

    case 'material':
      if (facet.value) {
        desc = `Must have material ${formatConstraint(facet.value)}`;
      } else {
        desc = 'Must have a material assigned';
      }
      break;

    case 'partOf': {
      const relName = facet.relation.replace('IfcRel', '').toLowerCase();
      if (facet.entity) {
        desc = `Must be ${relName} ${formatConstraint(facet.entity.name)}`;
      } else {
        desc = `Must be ${relName} some entity`;
      }
      break;
    }

    default:
      desc = 'Unknown requirement';
  }

  if (optionality === 'prohibited') {
    desc = desc.replace('Must', 'Must NOT').replace('must', 'must NOT');
  } else if (optionality === 'optional') {
    desc = desc.replace('Must', 'Should').replace('must', 'should');
  }

  return desc;
}
