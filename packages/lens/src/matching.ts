/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LensCriteria, LensDataProvider } from './types.js';
import { IFC_SUBTYPE_TO_BASE } from './types.js';

/**
 * Check if an entity matches a {@link LensCriteria}.
 *
 * Performance: O(1) for type/attribute, O(psets) for property/material/classification.
 */
export function matchesCriteria(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  switch (criteria.type) {
    case 'ifcType':
      return matchesIfcType(criteria, globalId, provider);
    case 'property':
      return matchesProperty(criteria, globalId, provider);
    case 'material':
      return matchesMaterial(criteria, globalId, provider);
    case 'attribute':
      return matchesAttribute(criteria, globalId, provider);
    case 'quantity':
      return matchesQuantity(criteria, globalId, provider);
    case 'classification':
      return matchesClassification(criteria, globalId, provider);
    case 'model':
      return matchesModel(criteria, globalId, provider);
    default:
      return false;
  }
}

/** Match by IFC class with subclass support */
function matchesIfcType(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.ifcType) return false;

  const typeName = provider.getEntityType(globalId);
  if (!typeName) return false;

  // Exact match
  if (typeName === criteria.ifcType) return true;

  // Subtype match: e.g. IfcSlabStandardCase matches an IfcSlab rule
  const baseType = IFC_SUBTYPE_TO_BASE[typeName];
  return baseType === criteria.ifcType;
}

/** Match by property value */
function matchesProperty(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.propertySet || !criteria.propertyName) return false;

  const value = provider.getPropertyValue(
    globalId,
    criteria.propertySet,
    criteria.propertyName,
  );

  if (criteria.operator === 'exists') {
    return value !== null && value !== undefined;
  }

  if (criteria.operator === 'contains' && criteria.propertyValue !== undefined) {
    return String(value ?? '').toLowerCase().includes(criteria.propertyValue.toLowerCase());
  }

  // Default: equals
  if (criteria.propertyValue !== undefined) {
    return String(value ?? '') === criteria.propertyValue;
  }

  return value !== null && value !== undefined;
}

/** Match by material — prefers dedicated getMaterialName, falls back to pset scan */
function matchesMaterial(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.materialName) return false;

  const pattern = criteria.materialName.toLowerCase();

  // Prefer dedicated material accessor if available
  if (provider.getMaterialName) {
    const matName = provider.getMaterialName(globalId);
    if (matName) {
      return matName.toLowerCase().includes(pattern);
    }
    return false;
  }

  // Fallback: scan material-related property sets
  const psets = provider.getPropertySets(globalId);
  if (!psets || psets.length === 0) return false;

  for (const pset of psets) {
    if (pset.name.toLowerCase().includes('material')) {
      for (const prop of pset.properties) {
        if (String(prop.value ?? '').toLowerCase().includes(pattern)) {
          return true;
        }
      }
    }
  }

  return false;
}

/** Match by entity attribute (Name, Description, ObjectType, Tag) */
function matchesAttribute(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.attributeName) return false;
  if (!provider.getEntityAttribute) return false;

  const value = provider.getEntityAttribute(globalId, criteria.attributeName);

  if (criteria.operator === 'exists') {
    return value !== undefined && value !== '';
  }

  if (criteria.operator === 'contains' && criteria.attributeValue !== undefined) {
    return (value ?? '').toLowerCase().includes(criteria.attributeValue.toLowerCase());
  }

  // Default: equals
  if (criteria.attributeValue !== undefined) {
    return (value ?? '') === criteria.attributeValue;
  }

  return value !== undefined && value !== '';
}

/** Match by quantity value (supports equals, contains, exists operators) */
function matchesQuantity(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.quantitySet || !criteria.quantityName) return false;
  if (!provider.getQuantityValue) return false;

  const value = provider.getQuantityValue(
    globalId,
    criteria.quantitySet,
    criteria.quantityName,
  );

  if (criteria.operator === 'exists') {
    return value !== undefined && value !== null;
  }

  if (value === undefined || value === null) return false;

  if (criteria.operator === 'contains' && criteria.quantityValue !== undefined) {
    return String(value).toLowerCase().includes(criteria.quantityValue.toLowerCase());
  }

  // Default: equals (string comparison)
  if (criteria.quantityValue !== undefined) {
    return String(value) === criteria.quantityValue;
  }

  return true;
}

/** Match by classification system and/or code */
function matchesClassification(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.classificationSystem && !criteria.classificationCode) return false;
  if (!provider.getClassifications) return false;

  const classifications = provider.getClassifications(globalId);
  if (!classifications || classifications.length === 0) return false;

  for (const cls of classifications) {
    const systemMatch = !criteria.classificationSystem ||
      (cls.system ?? '').toLowerCase().includes(criteria.classificationSystem.toLowerCase());
    const codeMatch = !criteria.classificationCode ||
      (cls.identification ?? '').toLowerCase().includes(criteria.classificationCode.toLowerCase());

    if (systemMatch && codeMatch) return true;
  }

  return false;
}

/** Match by federated model identifier */
function matchesModel(
  criteria: LensCriteria,
  globalId: number,
  provider: LensDataProvider,
): boolean {
  if (!criteria.modelId) return false;
  if (!provider.getModelId) return false;

  return provider.getModelId(globalId) === criteria.modelId;
}
