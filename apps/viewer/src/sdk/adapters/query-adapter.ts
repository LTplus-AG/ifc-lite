/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  EntityRef,
  EntityData,
  EntityAttributeData,
  PropertySetData,
  QuantitySetData,
  ClassificationData,
  MaterialData,
  TypePropertiesData,
  DocumentData,
  EntityRelationshipsData,
  QueryDescriptor,
  QueryBackendMethods,
} from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { EntityNode } from '@ifc-lite/query';
import { RelationshipType, IfcTypeEnum, IfcTypeEnumFromString } from '@ifc-lite/data';
import { getModelForRef, getAllModelEntries } from './model-compat.js';
import {
  extractAllEntityAttributes,
  extractClassificationsOnDemand,
  extractMaterialsOnDemand,
  extractTypePropertiesOnDemand,
  extractDocumentsOnDemand,
  extractRelationshipsOnDemand,
} from '@ifc-lite/parser';
import { applyAttributeMutationsToEntityData, mergeAttributeMutations } from './mutation-view.js';

/** Map IFC relationship entity names to internal RelationshipType enum.
 * Keys use proper IFC schema names (e.g. IfcRelAggregates, not "Aggregates"). */
const REL_TYPE_MAP: Record<string, RelationshipType> = {
  IfcRelContainedInSpatialStructure: RelationshipType.ContainsElements,
  IfcRelAggregates: RelationshipType.Aggregates,
  IfcRelDefinesByType: RelationshipType.DefinesByType,
  IfcRelVoidsElement: RelationshipType.VoidsElement,
  IfcRelFillsElement: RelationshipType.FillsElement,
};

/**
 * IFC4 subtype map — maps parent types to their StandardCase/ElementedCase subtypes.
 * In IFC4, many element types have *StandardCase subtypes that the parser stores
 * as the full type name. This map lets byType('IfcWall') also find IfcWallStandardCase.
 *
 * Keys and values are UPPERCASE because entityIndex.byType uses UPPERCASE keys
 * (raw STEP type names, e.g. IFCWALLSTANDARDCASE).
 */
const IFC_SUBTYPES: Record<string, string[]> = {
  IFCWALL: ['IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE'],
  IFCBEAM: ['IFCBEAMSTANDARDCASE'],
  IFCCOLUMN: ['IFCCOLUMNSTANDARDCASE'],
  IFCDOOR: ['IFCDOORSTANDARDCASE'],
  IFCWINDOW: ['IFCWINDOWSTANDARDCASE'],
  IFCSLAB: ['IFCSLABSTANDARDCASE', 'IFCSLABELEMENTEDCASE'],
  IFCMEMBER: ['IFCMEMBERSTANDARDCASE'],
  IFCPLATE: ['IFCPLATESTANDARDCASE'],
  IFCOPENINGELEMENT: ['IFCOPENINGSTANDARDCASE'],
};

/**
 * Expand a type list to include known IFC subtypes.
 * Converts PascalCase input (e.g. 'IfcWall') to UPPERCASE for entityIndex lookup.
 */
function expandTypes(types: string[]): string[] {
  const result: string[] = [];
  for (const type of types) {
    const upper = type.toUpperCase();
    result.push(upper);
    const subtypes = IFC_SUBTYPES[upper];
    if (subtypes) {
      for (const sub of subtypes) result.push(sub);
    }
  }
  return result;
}

/**
 * Check if a type name represents a product/spatial entity.
 *
 * Uses IfcTypeEnum as a whitelist — only known IFC types pass.
 * Excludes relationships, properties, quantities, element quantities,
 * and type objects (IfcWallType, IfcDoorType, etc.).
 *
 * Type names from entityIndex.byType are UPPERCASE (e.g. IFCWALLSTANDARDCASE).
 */
function isProductType(type: string): boolean {
  const enumVal = IfcTypeEnumFromString(type);
  // Unknown = not a recognized product/spatial type (geometry definitions, placements, etc.)
  if (enumVal === IfcTypeEnum.Unknown) return false;
  // Exclude relationships, properties, quantities
  const upper = type.toUpperCase();
  if (upper.startsWith('IFCREL')) return false;
  if (upper.startsWith('IFCPROPERTY')) return false;
  if (upper.startsWith('IFCQUANTITY')) return false;
  if (upper === 'IFCELEMENTQUANTITY') return false;
  // Exclude type objects (IfcWallType, IfcDoorType, etc.) — metadata, not instances
  if (upper.endsWith('TYPE')) return false;
  return true;
}

function normalizePropertyValue(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createQueryAdapter(store: StoreApi): QueryBackendMethods {
  function getEntityData(ref: EntityRef): EntityData | null {
    const state = store.getState();
    const model = getModelForRef(state, ref.modelId);
    if (!model?.ifcDataStore) return null;

    const node = new EntityNode(model.ifcDataStore, ref.expressId);
    return applyAttributeMutationsToEntityData(store, ref.modelId, ref.expressId, {
      ref,
      globalId: node.globalId,
      name: node.name,
      type: node.type,
      description: node.description,
      objectType: node.objectType,
    });
  }

  function getProperties(ref: EntityRef): PropertySetData[] {
    const state = store.getState();
    const model = getModelForRef(state, ref.modelId);
    if (!model?.ifcDataStore) return [];

    const node = new EntityNode(model.ifcDataStore, ref.expressId);
    return node.properties().map((pset) => ({
      name: pset.name,
      globalId: pset.globalId,
      properties: pset.properties.map((p) => ({
        name: p.name,
        type: p.type,
        value: p.value as string | number | boolean | null,
      })),
    }));
  }

  function getAttributes(ref: EntityRef): EntityAttributeData[] {
    const state = store.getState();
    const model = getModelForRef(state, ref.modelId);
    if (!model?.ifcDataStore) return [];
    return mergeAttributeMutations(
      extractAllEntityAttributes(model.ifcDataStore, ref.expressId),
      store,
      ref.modelId,
      ref.expressId,
    );
  }

  function getQuantities(ref: EntityRef): QuantitySetData[] {
    const state = store.getState();
    const model = getModelForRef(state, ref.modelId);
    if (!model?.ifcDataStore) return [];

    const node = new EntityNode(model.ifcDataStore, ref.expressId);
    return node.quantities().map(qset => ({
      name: qset.name,
      quantities: qset.quantities.map(q => ({
        name: q.name,
        type: q.type,
        value: q.value,
      })),
    }));
  }

  function getClassifications(ref: EntityRef): ClassificationData[] {
    const state = store.getState();
    const model = getModelForRef(state, ref.modelId);
    if (!model?.ifcDataStore) return [];
    return extractClassificationsOnDemand(model.ifcDataStore, ref.expressId);
  }

  function getMaterials(ref: EntityRef): MaterialData | null {
    const state = store.getState();
    const model = getModelForRef(state, ref.modelId);
    if (!model?.ifcDataStore) return null;
    return extractMaterialsOnDemand(model.ifcDataStore, ref.expressId);
  }

  function getTypeProperties(ref: EntityRef): TypePropertiesData | null {
    const state = store.getState();
    const model = getModelForRef(state, ref.modelId);
    if (!model?.ifcDataStore) return null;
    const info = extractTypePropertiesOnDemand(model.ifcDataStore, ref.expressId);
    if (!info) return null;
    return {
      typeName: info.typeName,
      typeId: info.typeId,
      properties: info.properties.map((pset) => ({
        name: pset.name,
        globalId: pset.globalId,
        properties: pset.properties.map((prop) => ({
          name: prop.name,
          type: prop.type,
          value: normalizePropertyValue(prop.value),
        })),
      })),
    };
  }

  function getDocuments(ref: EntityRef): DocumentData[] {
    const state = store.getState();
    const model = getModelForRef(state, ref.modelId);
    if (!model?.ifcDataStore) return [];
    return extractDocumentsOnDemand(model.ifcDataStore, ref.expressId);
  }

  function getRelationships(ref: EntityRef): EntityRelationshipsData {
    const state = store.getState();
    const model = getModelForRef(state, ref.modelId);
    if (!model?.ifcDataStore) {
      return { voids: [], fills: [], groups: [], connections: [] };
    }
    return extractRelationshipsOnDemand(model.ifcDataStore, ref.expressId);
  }

  function queryEntities(descriptor: QueryDescriptor): EntityData[] {
    const state = store.getState();
    const results: EntityData[] = [];

    const modelEntries = descriptor.modelId
      ? [[descriptor.modelId, getModelForRef(state, descriptor.modelId)] as const].filter(([, m]) => m)
      : getAllModelEntries(state);

    for (const [modelId, model] of modelEntries) {
      if (!model?.ifcDataStore) continue;

      let entityIds: number[];
      if (descriptor.types && descriptor.types.length > 0) {
        // Expand types to include IFC4 subtypes (e.g., IfcWall → IfcWallStandardCase)
        entityIds = [];
        for (const type of expandTypes(descriptor.types)) {
          const typeIds = model.ifcDataStore.entityIndex.byType.get(type) ?? [];
          for (const id of typeIds) entityIds.push(id);
        }
      } else {
        // No type filter — return product entities only (skip relationships, property defs)
        entityIds = [];
        for (const [typeName, ids] of model.ifcDataStore.entityIndex.byType) {
          if (isProductType(typeName)) {
            for (const id of ids) entityIds.push(id);
          }
        }
      }
      for (const expressId of entityIds) {
        if (expressId === 0) continue;
        const node = new EntityNode(model.ifcDataStore, expressId);
        results.push(applyAttributeMutationsToEntityData(store, modelId, expressId, {
          ref: { modelId, expressId },
          globalId: node.globalId,
          name: node.name,
          type: node.type,
          description: node.description,
          objectType: node.objectType,
        }));
      }
    }

    // Apply property filters
    let filtered = results;
    if (descriptor.filters && descriptor.filters.length > 0) {
      // Cache properties per entity to avoid O(n²) re-extraction per filter
      const propsCache = new Map<string, PropertySetData[]>();
      const getCachedProps = (ref: EntityRef): PropertySetData[] => {
        const key = `${ref.modelId}:${ref.expressId}`;
        let cached = propsCache.get(key);
        if (!cached) {
          cached = getProperties(ref);
          propsCache.set(key, cached);
        }
        return cached;
      };

      for (const filter of descriptor.filters) {
        filtered = filtered.filter(entity => {
          const props = getCachedProps(entity.ref);
          const pset = props.find(p => p.name === filter.psetName);
          if (!pset) return false;
          const prop = pset.properties.find(p => p.name === filter.propName);
          if (!prop) return false;
          if (filter.operator === 'exists') return true;

          const val = prop.value;
          switch (filter.operator) {
            case '=': return String(val) === String(filter.value);
            case '!=': return String(val) !== String(filter.value);
            case '>': return Number(val) > Number(filter.value);
            case '<': return Number(val) < Number(filter.value);
            case '>=': return Number(val) >= Number(filter.value);
            case '<=': return Number(val) <= Number(filter.value);
            case 'contains': return String(val).includes(String(filter.value));
            default: return false;
          }
        });
      }
    }

    if (descriptor.offset != null && descriptor.offset > 0) filtered = filtered.slice(descriptor.offset);
    if (descriptor.limit != null && descriptor.limit > 0) filtered = filtered.slice(0, descriptor.limit);

    return filtered;
  }

  return {
    entities: queryEntities,
    entityData: getEntityData,
    attributes: getAttributes,
    properties: getProperties,
    quantities: getQuantities,
    classifications: getClassifications,
    materials: getMaterials,
    typeProperties: getTypeProperties,
    documents: getDocuments,
    relationships: getRelationships,
    related(ref: EntityRef, relType: string, direction: 'forward' | 'inverse') {
      const state = store.getState();
      const model = getModelForRef(state, ref.modelId);
      if (!model?.ifcDataStore) return [];
      const relEnum = REL_TYPE_MAP[relType];
      if (relEnum === undefined) return [];
      const targets = model.ifcDataStore.relationships.getRelated(ref.expressId, relEnum, direction);
      return targets.map((expressId: number) => ({ modelId: ref.modelId, expressId }));
    },
  };
}
