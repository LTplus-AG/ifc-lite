/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build the data accessor that `@ifc-lite/ids` validators expect. Mirrors the
 * accessor used by `@ifc-lite/cli` so we get identical semantics on both
 * surfaces. Co-locating this in the MCP package avoids a CLI runtime
 * dependency, which would also drag in the viewer-core renderer.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import {
  extractAllEntityAttributes,
  extractClassificationsOnDemand,
  extractMaterialsOnDemand,
  extractTypeEntityOwnProperties,
} from '@ifc-lite/parser';
import { EntityNode } from '@ifc-lite/query';
import { RelationshipType } from '@ifc-lite/data';

const REL_TYPE_MAP: Record<string, RelationshipType> = {
  IfcRelAggregates: RelationshipType.Aggregates,
  IfcRelContainedInSpatialStructure: RelationshipType.ContainsElements,
  IfcRelNests: RelationshipType.Aggregates,
  IfcRelVoidsElement: RelationshipType.VoidsElement,
  IfcRelFillsElement: RelationshipType.FillsElement,
};

export function buildIdsAccessor(store: IfcDataStore): unknown {
  return {
    getEntityType(expressId: number): string | undefined {
      return store.entities.getTypeName(expressId) || undefined;
    },
    getEntityName(expressId: number): string | undefined {
      return new EntityNode(store, expressId).name || undefined;
    },
    getGlobalId(expressId: number): string | undefined {
      return new EntityNode(store, expressId).globalId || undefined;
    },
    getDescription(expressId: number): string | undefined {
      return new EntityNode(store, expressId).description || undefined;
    },
    getObjectType(expressId: number): string | undefined {
      const node = new EntityNode(store, expressId);
      if (node.objectType) return node.objectType;
      const allAttrs = extractAllEntityAttributes(store, expressId);
      const predefined = allAttrs.find((a) => a.name === 'PredefinedType');
      if (predefined?.value && predefined.value !== 'NOTDEFINED') {
        return typeof predefined.value === 'string' ? predefined.value : String(predefined.value);
      }
      const objType = allAttrs.find((a) => a.name === 'ObjectType');
      if (objType?.value === undefined || objType.value === null) return undefined;
      return typeof objType.value === 'string' ? objType.value : String(objType.value);
    },
    getEntitiesByType(typeName: string): number[] {
      return [...(store.entityIndex.byType.get(typeName.toUpperCase()) ?? [])];
    },
    getAllEntityIds(): number[] {
      const ids: number[] = [];
      for (const [, list] of store.entityIndex.byType) for (const id of list) ids.push(id);
      return ids;
    },
    getPropertyValue(expressId: number, psetName: string, propName: string) {
      const node = new EntityNode(store, expressId);
      for (const pset of node.properties()) {
        if (pset.name !== psetName) continue;
        for (const prop of pset.properties) {
          if (prop.name === propName) {
            return { value: prop.value ?? null, dataType: prop.type ?? 'IFCLABEL', propertySetName: pset.name, propertyName: prop.name };
          }
        }
      }
      return undefined;
    },
    getPropertySets(expressId: number) {
      const node = new EntityNode(store, expressId);
      const psets = node.properties();
      const mapPsets = (raw: Array<{ name: string; properties: Array<{ name: string; type: unknown; value: unknown }> }>) =>
        raw.map((p) => ({
          name: p.name,
          properties: p.properties.map((pp) => ({ name: pp.name, value: pp.value ?? null, dataType: pp.type ?? 'IFCLABEL' })),
        }));
      if (psets.length > 0) return mapPsets(psets);
      const typePsets = extractTypeEntityOwnProperties(store, expressId);
      if (typePsets.length > 0) return mapPsets(typePsets);
      return [];
    },
    getClassifications(expressId: number) {
      return extractClassificationsOnDemand(store, expressId).map((c) => ({
        system: c.system ?? '',
        value: c.identification ?? '',
        name: c.name ?? undefined,
      }));
    },
    getMaterials(expressId: number) {
      const data = extractMaterialsOnDemand(store, expressId);
      if (!data) return [];
      const materials: Array<{ name: string; category?: string }> = [];
      if (data.name) materials.push({ name: data.name });
      if (data.layers) for (const layer of data.layers) {
        if (layer.materialName) materials.push({ name: layer.materialName, category: layer.category ?? undefined });
      }
      return materials;
    },
    getParent(expressId: number, relationType: string) {
      const relEnum = REL_TYPE_MAP[relationType];
      if (relEnum === undefined) return undefined;
      const parents = store.relationships.getRelated(expressId, relEnum, 'inverse');
      if (parents.length === 0) return undefined;
      const parentId = parents[0];
      const parentType = store.entities.getTypeName(parentId);
      const attrs = extractAllEntityAttributes(store, parentId);
      const predefined = attrs.find((a) => a.name === 'PredefinedType');
      return {
        expressId: parentId,
        entityType: parentType ?? '',
        predefinedType: predefined?.value && predefined.value !== 'NOTDEFINED' ? predefined.value : undefined,
      };
    },
    getAttribute(expressId: number, name: string): string | number | boolean | undefined {
      const node = new EntityNode(store, expressId);
      switch (name) {
        case 'Name': return node.name || undefined;
        case 'Description': return node.description || undefined;
        case 'ObjectType': return node.objectType || undefined;
        case 'GlobalId': return node.globalId || undefined;
        case 'Tag': return node.tag || undefined;
        default: {
          const attrs = extractAllEntityAttributes(store, expressId);
          const attr = attrs.find((a) => a.name === name);
          return attr?.value;
        }
      }
    },
  };
}
