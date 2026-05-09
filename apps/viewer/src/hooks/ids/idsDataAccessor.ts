/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS Data Accessor Factory
 *
 * Creates an IFCDataAccessor bridge from an IfcDataStore to the IDS
 * validator's expected interface. This is a pure function with no
 * React dependencies.
 */

import type {
  IFCDataAccessor,
  PropertyValueResult,
  PropertySetInfo,
  ClassificationInfo,
  MaterialInfo,
  ParentInfo,
  PartOfRelation,
} from '@ifc-lite/ids';
import {
  type IfcDataStore,
  extractAllEntityAttributes,
  extractClassificationsOnDemand,
  extractMaterialsOnDemand,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractTypeEntityOwnProperties,
} from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';

// Map IDS PartOf relations to the numeric RelationshipType enum the
// graph keys on. Passing strings here was a long-standing silent bug:
// `getRelated` matched nothing → every partOf check looked like
// "no parent" → fail-when-required, pass-when-prohibited.
const PARTOF_REL_MAP: Record<PartOfRelation, RelationshipType | undefined> = {
  IfcRelAggregates: RelationshipType.Aggregates,
  IfcRelContainedInSpatialStructure: RelationshipType.ContainsElements,
  IfcRelNests: RelationshipType.Aggregates,
  IfcRelVoidsElement: RelationshipType.VoidsElement,
  IfcRelFillsElement: RelationshipType.FillsElement,
};

function flattenMaterials(matInfo: ReturnType<typeof extractMaterialsOnDemand>): MaterialInfo[] {
  if (!matInfo) return [];
  const out: MaterialInfo[] = [];
  const push = (name?: string, category?: string) => {
    if (!name) return;
    out.push({ name, category });
  };
  switch (matInfo.type) {
    case 'Material':
      push(matInfo.name, matInfo.category);
      // IDS material `<value>` may match either the Name OR the
      // Category — push category as an alias so value checks match.
      if (matInfo.category) push(matInfo.category, matInfo.category);
      break;
    case 'MaterialList':
      for (const m of matInfo.materials || []) push(m);
      break;
    case 'MaterialLayerSet':
      push(matInfo.name);
      for (const layer of matInfo.layers || []) {
        push(layer.materialName, layer.category);
        push(layer.name, layer.category);
        if (layer.materialCategory) push(layer.materialCategory, layer.materialCategory);
      }
      break;
    case 'MaterialConstituentSet':
      push(matInfo.name);
      for (const c of matInfo.constituents || []) {
        push(c.materialName, c.category);
        push(c.name, c.category);
        if (c.materialCategory) push(c.materialCategory, c.materialCategory);
      }
      break;
    case 'MaterialProfileSet':
      push(matInfo.name);
      for (const p of matInfo.profiles || []) {
        push(p.materialName, p.category);
        push(p.name, p.category);
        if (p.materialCategory) push(p.materialCategory, p.materialCategory);
      }
      break;
  }
  return out;
}

function findAttributeValue(
  dataStore: IfcDataStore,
  expressId: number,
  attributeName: string
): string | undefined {
  const lower = attributeName.toLowerCase();
  const all = extractAllEntityAttributes(dataStore, expressId);
  for (const a of all) {
    if (a.name.toLowerCase() === lower) return a.value;
  }
  return undefined;
}

function idsDataTypeForProperty(type: number | string | undefined): string {
  if (typeof type === 'string') {
    if (type.startsWith('IFC') || type.startsWith('Ifc')) return type.toUpperCase();
    return 'IFCLABEL';
  }
  // PropertyValueType enum from @ifc-lite/data.
  switch (type) {
    case 0: return 'IFCLABEL';
    case 1: return 'IFCREAL';
    case 2: return 'IFCINTEGER';
    case 3: return 'IFCBOOLEAN';
    case 4: return 'IFCLOGICAL';
    case 5: return 'IFCLABEL';
    case 6: return 'IFCIDENTIFIER';
    case 7: return 'IFCTEXT';
    case 8: return 'IFCLABEL';
    case 9: return 'IFCIDENTIFIER';
    case 10: return 'IFCLABEL';
    default: return 'IFCLABEL';
  }
}

function idsDataTypeForQuantity(type: number): string {
  switch (type) {
    case 0: return 'IFCLENGTHMEASURE';
    case 1: return 'IFCAREAMEASURE';
    case 2: return 'IFCVOLUMEMEASURE';
    case 3: return 'IFCCOUNTMEASURE';
    case 4: return 'IFCMASSMEASURE';
    case 5: return 'IFCTIMEMEASURE';
    default: return 'IFCLABEL';
  }
}

function collectAllPropertySets(
  dataStore: IfcDataStore,
  expressId: number
): PropertySetInfo[] {
  const out: PropertySetInfo[] = [];
  let props: Array<{ name: string; properties: Array<{ name: string; value: unknown; type: unknown }> }> | undefined =
    dataStore.properties?.getForEntity?.(expressId) as
      | Array<{ name: string; properties: Array<{ name: string; value: unknown; type: unknown }> }>
      | undefined;
  if (!props || props.length === 0) {
    props = extractPropertiesOnDemand(dataStore, expressId) as Array<{
      name: string;
      properties: Array<{ name: string; value: unknown; type: unknown }>;
    }>;
  }
  if (props && props.length > 0) {
    for (const pset of props) {
      out.push({
        name: pset.name,
        properties: (pset.properties || []).map((p) => ({
          name: p.name,
          value: Array.isArray(p.value) ? JSON.stringify(p.value) : (p.value as string | number | boolean | null),
          dataType: idsDataTypeForProperty(p.type as number | string | undefined),
        })),
      });
    }
  }
  let quantities = dataStore.quantities?.getForEntity?.(expressId);
  if (!quantities || quantities.length === 0) {
    quantities = extractQuantitiesOnDemand(dataStore, expressId);
  }
  if (quantities && quantities.length > 0) {
    for (const qset of quantities) {
      out.push({
        name: qset.name,
        properties: (qset.quantities || []).map((q) => ({
          name: q.name,
          value: q.value,
          dataType: idsDataTypeForQuantity(q.type),
        })),
      });
    }
  }
  if (out.length === 0) {
    const typePsets = extractTypeEntityOwnProperties(dataStore, expressId);
    if (typePsets.length > 0) {
      for (const pset of typePsets) {
        out.push({
          name: pset.name,
          properties: (pset.properties || []).map((p) => ({
            name: p.name,
            value: Array.isArray(p.value) ? JSON.stringify(p.value) : (p.value as string | number | boolean | null),
            dataType: idsDataTypeForProperty(p.type as number | string | undefined),
          })),
        });
      }
    }
  }
  return out;
}

/**
 * Create an IFCDataAccessor from an IfcDataStore
 * This bridges the viewer's data store to the IDS validator's interface
 */
export function createDataAccessor(
  dataStore: IfcDataStore,
  _modelId: string
): IFCDataAccessor {
  return {
    getEntityType(expressId: number): string | undefined {
      // Try entities table first
      const entityType = dataStore.entities?.getTypeName?.(expressId);
      if (entityType) return entityType;

      // Fallback to entityIndex
      const byId = dataStore.entityIndex?.byId;
      if (byId) {
        const entry = byId.get(expressId);
        if (entry) {
          return typeof entry === 'object' && 'type' in entry ? String(entry.type) : undefined;
        }
      }
      return undefined;
    },

    getEntityName(expressId: number): string | undefined {
      const n = dataStore.entities?.getName?.(expressId);
      if (n) return n;
      // Fall back to direct attribute extraction for entities the
      // entity-table summariser didn't index (e.g. IfcClassification).
      return findAttributeValue(dataStore, expressId, 'Name');
    },

    getGlobalId(expressId: number): string | undefined {
      const g = dataStore.entities?.getGlobalId?.(expressId);
      if (g) return g;
      return findAttributeValue(dataStore, expressId, 'GlobalId');
    },

    getDescription(expressId: number): string | undefined {
      const d = dataStore.entities?.getDescription?.(expressId);
      if (d) return d;
      return findAttributeValue(dataStore, expressId, 'Description');
    },

    getObjectType(expressId: number): string | undefined {
      // IDS predefined-type semantics (matches upstream IfcOpenShell):
      //  - If PredefinedType is `USERDEFINED`, the real type lives in
      //    ElementType (for IfcTypeObject subtypes like IfcWallType) or
      //    ObjectType (for IfcObject subtypes).
      //  - If PredefinedType is `NOTDEFINED` or absent, fall back to
      //    ObjectType.
      //  - Otherwise the PredefinedType enum value IS the answer.
      const allAttrs = extractAllEntityAttributes(dataStore, expressId);
      const pdt = allAttrs.find((a) => a.name === 'PredefinedType');
      const pdtValue = pdt?.value;
      if (pdtValue && pdtValue !== 'NOTDEFINED' && pdtValue !== 'USERDEFINED') {
        return pdtValue;
      }
      const userSlot =
        allAttrs.find((a) => a.name === 'ElementType') ||
        allAttrs.find((a) => a.name === 'ObjectType') ||
        allAttrs.find((a) => a.name === 'ProcessType') ||
        allAttrs.find((a) => a.name === 'ResourceType');
      if (userSlot?.value) return userSlot.value;
      const ot = dataStore.entities?.getObjectType?.(expressId);
      return ot ?? pdtValue ?? undefined;
    },

    getEntitiesByType(typeName: string): number[] {
      const byType = dataStore.entityIndex?.byType;
      if (byType) {
        const ids = byType.get(typeName.toUpperCase());
        if (ids) return Array.from(ids);
      }
      return [];
    },

    getAllEntityIds(): number[] {
      const byId = dataStore.entityIndex?.byId;
      if (byId) {
        return Array.from(byId.keys());
      }
      return [];
    },

    getPropertyValue(
      expressId: number,
      propertySetName: string,
      propertyName: string
    ): PropertyValueResult | undefined {
      const all = collectAllPropertySets(dataStore, expressId);
      for (const pset of all) {
        if (pset.name.toLowerCase() !== propertySetName.toLowerCase()) continue;
        for (const prop of pset.properties || []) {
          if (prop.name.toLowerCase() !== propertyName.toLowerCase()) continue;
          return {
            value: prop.value,
            dataType: prop.dataType,
            propertySetName: pset.name,
            propertyName: prop.name,
          };
        }
      }
      return undefined;
    },

    getPropertySets(expressId: number): PropertySetInfo[] {
      return collectAllPropertySets(dataStore, expressId);
    },

    getClassifications(expressId: number): ClassificationInfo[] {
      const list = extractClassificationsOnDemand(dataStore, expressId) || [];
      return list.map((c) => ({
        system: c.system || '',
        // The validator's `value` field carries the classification *code*
        // (e.g. "EF_25_10"). The parser exposes that as `identification`.
        value: c.identification || c.name || '',
        name: c.name,
      }));
    },

    getMaterials(expressId: number): MaterialInfo[] {
      return flattenMaterials(extractMaterialsOnDemand(dataStore, expressId));
    },

    getParent(
      expressId: number,
      relationType: PartOfRelation
    ): ParentInfo | undefined {
      const relationships = dataStore.relationships;
      if (!relationships?.getRelated) return undefined;
      const relType = PARTOF_REL_MAP[relationType];
      if (relType === undefined) return undefined;
      const parents = relationships.getRelated(expressId, relType, 'inverse');
      if (!parents || parents.length === 0) return undefined;
      const parentId = parents[0];
      return {
        expressId: parentId,
        entityType: this.getEntityType(parentId) || 'Unknown',
        predefinedType: this.getObjectType(parentId),
      };
    },

    getAttribute(expressId: number, attributeName: string): string | undefined {
      const lowerName = attributeName.toLowerCase();
      switch (lowerName) {
        case 'name':
          return this.getEntityName(expressId);
        case 'description':
          return this.getDescription(expressId);
        case 'globalid':
          return this.getGlobalId(expressId);
        case 'objecttype':
        case 'predefinedtype':
          return this.getObjectType(expressId);
        default: {
          // For arbitrary attributes (EditionDate, Tag, etc.), fall back
          // to the parser's full-attribute extractor.
          const fromExtract = findAttributeValue(dataStore, expressId, attributeName);
          if (fromExtract !== undefined) return fromExtract;
          const entities = dataStore.entities as {
            getAttribute?: (id: number, attr: string) => string | undefined;
          };
          return entities?.getAttribute
            ? entities.getAttribute(expressId, attributeName)
            : undefined;
        }
      }
    },
  };
}
