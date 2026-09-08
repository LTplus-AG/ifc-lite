/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  type IfcDataStore,
  extractAllEntityAttributes,
  extractAllMaterialsOnDemand,
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
import { resolvePartOfAncestors } from './ancestors.js';
import {
  resolveEffectivePropertySets,
  type PropertyOverride,
  type PropertyOverlayResolver,
} from './property-overlay-resolver.js';
import {
  resolveObjectType,
  resolveRawPredefinedType,
} from './predefined-types.js';
import { narrowSchemaVersion } from './schema-version.js';

export type { PropertyOverride, PropertyOverlayResolver };

// `PropertyOverride`/`PropertyOverlayResolver` are re-exported above from
// ./property-overlay-resolver.js; the PartOf relation map and ancestor BFS
// walk live in ./ancestors.js — see `resolvePartOfAncestors` below.

/**
 * Bridge an `IfcDataStore` (produced by `@ifc-lite/parser`) into the
 * abstract `IFCDataAccessor` the IDS validator consumes. The single
 * canonical translation: viewer, MCP server, and the buildingSMART corpus
 * harness (`src/__corpus__/corpus.test.ts`) all use this rather than
 * re-implementing the projection.
 *
 * Mirrors upstream `IfcOpenShell/ifctester` semantics: classification
 * sub-reference walking, IfcExternalReferenceRelationship for
 * non-rooted resources, length unit conversion, predefined property-set
 * unwrapping, schema-driven attribute XSD types, USERDEFINED predicate
 * substitution, partOf transitivity, etc.
 *
 * `propertyOverlay` is optional and lets a caller with in-memory,
 * not-yet-exported property edits (e.g. an IDS correction applied through
 * the viewer's `MutablePropertyView`) have those edits reflected in
 * `getPropertyValue`/`getPropertySets` immediately, without re-parsing the
 * store. Every other read (attributes, classifications, materials, partOf)
 * is unaffected — only the two property-reading methods below consult it.
 */
export function createDataAccessor(
  store: IfcDataStore,
  propertyOverlay?: PropertyOverlayResolver
): IFCDataAccessor {
  // Memoize per-entity attribute extraction. extractAllEntityAttributes
  // re-parses the entity from the raw source buffer on every call, and the
  // validator hits Name/GlobalId/Description/getAttribute(Names) for the same
  // entity many times per specification. Caching collapses those repeated
  // full re-parses to a single extraction per entity for this accessor's store.
  const attrCache = new Map<
    number,
    Array<{ name: string; value: string | number | boolean }>
  >();
  function getEntityAttributes(
    expressId: number
  ): Array<{ name: string; value: string | number | boolean }> {
    let all = attrCache.get(expressId);
    if (!all) {
      all = extractAllEntityAttributes(store, expressId);
      attrCache.set(expressId, all);
    }
    return all;
  }

  function findAttributeValue(
    expressId: number,
    attributeName: string
  ): string | number | boolean | undefined {
    const lower = attributeName.toLowerCase();
    const all = getEntityAttributes(expressId);
    for (const a of all) {
      if (a.name.toLowerCase() === lower) return a.value;
    }
    return undefined;
  }

  /**
   * Property sets for `expressId`, with any pending overlay writes applied
   * on top of the canonical (parsed) result. See
   * `resolveEffectivePropertySets` (./property-overlay-resolver.js) for the
   * merge semantics.
   */
  function getEffectivePropertySets(expressId: number): PropertySetInfo[] {
    return resolveEffectivePropertySets(store, expressId, propertyOverlay);
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
      return getEntityAttributes(expressId).map((a) => a.name);
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

    getSchemaVersion(): string | undefined {
      return store.schemaVersion;
    },

    getTypeEntityType(expressId: number): string | undefined {
      const typeIds =
        store.relationships?.getRelated?.(
          expressId,
          RelationshipType.DefinesByType,
          'inverse'
        ) || [];
      for (const typeId of typeIds) {
        const t = accessor.getEntityType(typeId);
        if (t) return t;
      }
      return undefined;
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
      const all = getEffectivePropertySets(expressId);
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
      return getEffectivePropertySets(expressId);
    },

    getClassifications(expressId: number): ClassificationInfo[] {
      return resolveClassifications(store, expressId);
    },

    getMaterials(expressId: number): MaterialInfo[] {
      // ALL associations — an IDS material requirement satisfied only by the
      // element's second IfcRelAssociatesMaterial must still pass.
      return extractAllMaterialsOnDemand(store, expressId).flatMap((info) => flattenMaterials(info));
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
      return resolvePartOfAncestors(
        store,
        expressId,
        relationType,
        (id) => accessor.getEntityType(id),
        (id) => accessor.getPredefinedTypeRaw?.(id),
        (id) => accessor.getObjectType(id)
      );
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
        // `predefinedtype` deliberately resolves through
        // `getObjectType` (the PredefinedType/USERDEFINED-name helper) —
        // but `objecttype` must NOT: that would shadow the entity's
        // actual `ObjectType` attribute with the PredefinedType enum
        // whenever PredefinedType is a concrete, non-USERDEFINED,
        // non-NOTDEFINED token. Let it fall through to the raw
        // attribute extraction below, same as any other named attribute.
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
