/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  type IfcDataStore,
  extractAllEntityAttributes,
  extractAllMaterialsOnDemand,
  getAttributeTypeForSchema,
} from '@ifc-lite/parser';
import {
  RelationshipType,
  exactTypeName,
  getAttributeXsdTypes,
  iterateEffectiveEntities,
} from '@ifc-lite/data';

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
import { createExternalReferenceContext, resolveClassifications, type ExternalReferenceContext } from './classifications.js';
import { resolvePartOfAncestors } from './ancestors.js';
import {
  resolveEffectivePropertySets,
  type PropertyOverride,
  type PropertyOverlayResolver,
} from './property-overlay-resolver.js';
import { resolvePredefinedType } from './predefined-types.js';
import { narrowSchemaVersion } from './schema-version.js';
import { overlayEntityLookup, type EntityVisibilityView } from './entity-visibility.js';
import { resolveEntityMeasureScales, toBaseSI } from './units.js';

export type { PropertyOverride, PropertyOverlayResolver };

export type { EntityVisibilityView };

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
 *
 * `entityVisibility` is optional and, when supplied, makes the accessor
 * answer for the session's EFFECTIVE model (#5184, #5249). `getAllEntityIds`
 * and `getEntitiesByType` enumerate through the shared effective-entity
 * accessor: tombstoned entities are excluded, overlay-created entities are
 * included under their class, and a retyped entity is listed under its new
 * class. `getEntityType` answers the same effective class, because the
 * validator confirms every candidate through it. A created entity's
 * attributes are read from its authored payload (see `./entity-visibility.ts`).
 * Omitting `entityVisibility` leaves both enumerations reading the parsed
 * index unchanged.
 */
export function createDataAccessor(
  store: IfcDataStore,
  propertyOverlay?: PropertyOverlayResolver,
  entityVisibility?: EntityVisibilityView
): IFCDataAccessor {
  const overlay = entityVisibility ? overlayEntityLookup(entityVisibility) : null;
  // Built on first classification read, once per accessor (#5249).
  let externalReferences: ExternalReferenceContext | undefined;

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
      all = overlay?.createdAttributes(expressId) ?? extractAllEntityAttributes(store, expressId);
      attrCache.set(expressId, all);
    }
    return all;
  }

  function findAttribute(
    expressId: number,
    attributeName: string
  ): { name: string; value: string | number | boolean } | undefined {
    const lower = attributeName.toLowerCase();
    return getEntityAttributes(expressId).find((a) => a.name.toLowerCase() === lower);
  }

  function findAttributeValue(
    expressId: number,
    attributeName: string
  ): string | number | boolean | undefined {
    return findAttribute(expressId, attributeName)?.value;
  }

  /**
   * A measure-typed attribute (`IfcDoor.OverallHeight`, an
   * `IfcPositiveLengthMeasure`) is stored in the project's units, and IDS
   * compares it in SI like a property value (#7395). The attribute's declared
   * EXPRESS type picks the conversion; any other attribute passes through.
   */
  function attributeInSi(
    expressId: number,
    attr: { name: string; value: string | number | boolean }
  ): string | number | boolean {
    if (typeof attr.value !== 'number') return attr.value;
    const entityType = accessor.getEntityType(expressId);
    const dataType = entityType
      ? getAttributeTypeForSchema(entityType, attr.name, store.schemaVersion)
      : undefined;
    if (!dataType) return attr.value;
    const si = toBaseSI(attr.value, dataType.toUpperCase(), resolveEntityMeasureScales(store, expressId));
    return typeof si === 'number' ? si : attr.value;
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
      const overlaid = overlay?.typeOf(expressId);
      if (overlaid) return overlaid;
      // The class the STEP line DECLARES, in IFC PascalCase: IDS entity
      // facets match the exact class. `getTypeName` coalesces eight
      // *StandardCase classes and two distribution subtypes onto their
      // parent's enum value (#7402), so it is not used here.
      // The columnar entity table only summarises "interesting"
      // entities (spatial, building elements, etc.); resource-level
      // types resolve to `'Unknown'` there. Fall back to the raw
      // type name from `entityIndex.byId` so applicability checks
      // for those types still match.
      const entityType = store.entities ? exactTypeName(store.entities, expressId) : undefined;
      if (entityType && entityType !== 'Unknown') return entityType;

      // @raw-entity-enumeration-ok point lookup of one source record's parsed class; created and retyped ids were answered from the overlay above
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
      const created = overlay?.globalIdOf(expressId);
      if (created) return created;
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
      return resolvePredefinedType(store, expressId, getEntityAttributes).raw;
    },

    getObjectType(expressId: number): string | undefined {
      // The IDS predefined-type value: the user-defined name for
      // USERDEFINED, else the enum token. Never the bare `ObjectType`
      // of an entity whose PredefinedType is unset or NOTDEFINED (#7394).
      const { raw, userDefined } = resolvePredefinedType(store, expressId, getEntityAttributes);
      return userDefined ?? raw;
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
      if (!store.entityIndex) return [];
      return Array.from(iterateEffectiveEntities(store, entityVisibility, [typeName]), (e) => e.expressId);
    },

    getAllEntityIds(): number[] {
      if (!store.entityIndex) return [];
      return Array.from(iterateEffectiveEntities(store, entityVisibility), (e) => e.expressId);
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
      externalReferences ??= createExternalReferenceContext(store, entityVisibility);
      return resolveClassifications(store, expressId, externalReferences);
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
        // No `predefinedtype` case: the attribute facet tests the
        // `PredefinedType` attribute as stored on this entity, so it
        // reads through the raw extraction below like any other named
        // attribute. The type-inherited, USERDEFINED-substituted value
        // is the ENTITY facet's notion (`getObjectType`), not an
        // attribute (#7394). Likewise `objecttype` must not resolve
        // through `getObjectType`, which would shadow the entity's real
        // `ObjectType` attribute with the PredefinedType enum.
        default: {
          const fromExtract = findAttribute(expressId, attributeName);
          if (fromExtract?.value !== undefined) return attributeInSi(expressId, fromExtract);
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
