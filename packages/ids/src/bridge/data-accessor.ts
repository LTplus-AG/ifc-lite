/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  type IfcDataStore,
  extractAllEntityAttributes,
  extractMaterialsOnDemand,
} from '@ifc-lite/parser';
import { RelationshipType, getAttributeXsdTypes } from '@ifc-lite/data';

import type {
  IFCDataAccessor,
  PartOfRelation,
  PropertyValueResult,
  PropertySetInfo,
  ClassificationInfo,
  MaterialInfo,
  ParentInfo,
} from '../types.js';

import { flattenMaterials } from './materials.js';
import { resolveClassifications } from './classifications.js';
import { collectAllPropertySets } from './properties.js';
import {
  resolveObjectType,
  resolveRawPredefinedType,
} from './predefined-types.js';
import { narrowSchemaVersion } from './schema-version.js';

// Map IDS PartOf relations to the numeric RelationshipType enum the
// graph keys on. Passing strings here was a long-standing silent bug:
// `getRelated` matched nothing → every partOf check looked like
// "no parent" → fail-when-required, pass-when-prohibited.
const PARTOF_REL_MAP: Record<PartOfRelation, RelationshipType | undefined> = {
  IfcRelAggregates: RelationshipType.Aggregates,
  IfcRelAssignsToGroup: RelationshipType.AssignsToGroup,
  IfcRelContainedInSpatialStructure: RelationshipType.ContainsElements,
  IfcRelNests: RelationshipType.Aggregates,
  IfcRelVoidsElement: RelationshipType.VoidsElement,
  IfcRelFillsElement: RelationshipType.FillsElement,
};

/**
 * Bridge an `IfcDataStore` (produced by `@ifc-lite/parser`) into the
 * abstract `IFCDataAccessor` the IDS validator consumes. The single
 * canonical translation — viewer, MCP server, and the corpus-parity
 * harness all use this rather than re-implementing the projection.
 *
 * Mirrors upstream `IfcOpenShell/ifctester` semantics: classification
 * sub-reference walking, IfcExternalReferenceRelationship for
 * non-rooted resources, length unit conversion, predefined property-set
 * unwrapping, schema-driven attribute XSD types, USERDEFINED predicate
 * substitution, partOf transitivity, etc.
 */
export function createDataAccessor(store: IfcDataStore): IFCDataAccessor {
  function findAttributeValue(
    expressId: number,
    attributeName: string
  ): string | number | boolean | undefined {
    const lower = attributeName.toLowerCase();
    const all = extractAllEntityAttributes(store, expressId);
    for (const a of all) {
      if (a.name.toLowerCase() === lower) return a.value;
    }
    return undefined;
  }

  const accessor: IFCDataAccessor = {
    getEntityType(expressId: number): string | undefined {
      // The columnar entity table only summarises "interesting"
      // entities (spatial, building elements, etc.); resource-level
      // types resolve to `'Unknown'` there. Fall back to the raw
      // type name from `entityIndex.byId` so applicability checks
      // for those types still match.
      const entityType = store.entities?.getTypeName?.(expressId);
      if (entityType && entityType !== 'Unknown') return entityType;

      const byId = store.entityIndex?.byId;
      if (!byId) return undefined;
      const entry = byId.get(expressId);
      if (!entry) return undefined;
      return typeof entry === 'object' && 'type' in entry
        ? String(entry.type)
        : undefined;
    },

    getEntityName(expressId: number): string | undefined {
      // Distinguish "slot truly absent" (`undefined`) from "slot
      // explicitly empty" (`''`) — the IDS optional-attribute fixtures
      // hinge on it. The columnar `entities.getName` shim returns `''`
      // for either case, so we round-trip through the attribute
      // extractor first to preserve the explicit empty string.
      const fromAttr = findAttributeValue(expressId, 'Name');
      if (fromAttr !== undefined && typeof fromAttr === 'string') return fromAttr;
      const n = store.entities?.getName?.(expressId);
      return n || undefined;
    },

    getGlobalId(expressId: number): string | undefined {
      const fromAttr = findAttributeValue(expressId, 'GlobalId');
      if (fromAttr !== undefined && typeof fromAttr === 'string') return fromAttr;
      const g = store.entities?.getGlobalId?.(expressId);
      return g || undefined;
    },

    getDescription(expressId: number): string | undefined {
      const fromAttr = findAttributeValue(expressId, 'Description');
      if (fromAttr !== undefined && typeof fromAttr === 'string') return fromAttr;
      const d = store.entities?.getDescription?.(expressId);
      return d || undefined;
    },

    getAttributeNames(expressId: number): string[] {
      return extractAllEntityAttributes(store, expressId).map((a) => a.name);
    },

    getAttributeXsdTypes(
      expressId: number,
      attrName: string
    ): readonly string[] | undefined {
      // Resolve the entity's IFC type so the schema lookup scopes to
      // the correct slot — the same attribute can carry different XSD
      // types on different entities.
      const entityType = accessor.getEntityType(expressId);
      if (!entityType) return undefined;
      return getAttributeXsdTypes(
        narrowSchemaVersion(store.schemaVersion),
        entityType,
        attrName
      );
    },

    getPredefinedTypeRaw(expressId: number): string | undefined {
      return resolveRawPredefinedType(store, expressId);
    },

    getObjectType(expressId: number): string | undefined {
      return resolveObjectType(store, expressId, () =>
        store.entities?.getObjectType?.(expressId)
      );
    },

    getEntitiesByType(typeName: string): number[] {
      const ids = store.entityIndex?.byType?.get(typeName.toUpperCase());
      return ids ? Array.from(ids) : [];
    },

    getAllEntityIds(): number[] {
      const byId = store.entityIndex?.byId;
      return byId ? Array.from(byId.keys()) : [];
    },

    getPropertyValue(
      expressId: number,
      propertySetName: string,
      propertyName: string
    ): PropertyValueResult | undefined {
      const psetLower = propertySetName.toLowerCase();
      const propLower = propertyName.toLowerCase();
      const all = collectAllPropertySets(store, expressId);
      for (const pset of all) {
        if (pset.name.toLowerCase() !== psetLower) continue;
        for (const prop of pset.properties || []) {
          if (prop.name.toLowerCase() !== propLower) continue;
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
      return collectAllPropertySets(store, expressId);
    },

    getClassifications(expressId: number): ClassificationInfo[] {
      return resolveClassifications(store, expressId);
    },

    getMaterials(expressId: number): MaterialInfo[] {
      return flattenMaterials(extractMaterialsOnDemand(store, expressId));
    },

    getParent(
      expressId: number,
      relationType: PartOfRelation
    ): ParentInfo | undefined {
      const all = accessor.getAncestors!(expressId, relationType);
      return all.length > 0 ? all[0] : undefined;
    },

    getAncestors(
      expressId: number,
      relationType: PartOfRelation
    ): ParentInfo[] {
      const relationships = store.relationships;
      if (!relationships?.getRelated) return [];
      const relType = PARTOF_REL_MAP[relationType];
      if (relType === undefined) return [];

      // BFS up the graph — IDS partOf is transitive, so any reachable
      // ancestor counts.
      const out: ParentInfo[] = [];
      const seen = new Set<number>([expressId]);
      const queue = [expressId];
      while (queue.length > 0) {
        const id = queue.shift()!;
        const parents = relationships.getRelated(id, relType, 'inverse');
        for (const parentId of parents || []) {
          if (seen.has(parentId)) continue;
          seen.add(parentId);
          out.push({
            expressId: parentId,
            entityType: accessor.getEntityType(parentId) || 'Unknown',
            predefinedType: accessor.getObjectType(parentId),
          });
          queue.push(parentId);
        }
      }
      return out;
    },

    getAttribute(
      expressId: number,
      attributeName: string
    ): string | number | boolean | undefined {
      const lowerName = attributeName.toLowerCase();
      switch (lowerName) {
        case 'name':
          return accessor.getEntityName(expressId);
        case 'description':
          return accessor.getDescription(expressId);
        case 'globalid':
          return accessor.getGlobalId(expressId);
        case 'objecttype':
        case 'predefinedtype':
          return accessor.getObjectType(expressId);
        default: {
          const fromExtract = findAttributeValue(expressId, attributeName);
          if (fromExtract !== undefined) return fromExtract;
          const entities = store.entities as {
            getAttribute?: (id: number, attr: string) => string | undefined;
          };
          return entities?.getAttribute
            ? entities.getAttribute(expressId, attributeName)
            : undefined;
        }
      }
    },
  };

  return accessor;
}
