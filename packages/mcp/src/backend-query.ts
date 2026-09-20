/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The read half of `HeadlessLikeBackend`, with the session's pending mutations
 * folded in (#2004).
 *
 * `MutablePropertyView` is an overlay: the parsed store's buffer and index are
 * never touched, and the edits only materialise in `StepExporter`. Every read
 * that went straight to the store therefore answered about the file *as parsed*,
 * so an agent that edited and then read back to confirm was told its edit had
 * not happened — and the natural recovery from that is to edit again.
 *
 * The fold lives here rather than in the tools because this is the one
 * chokepoint they all pass through: `get_entity`, `query_entities`,
 * `get_entities_bulk`, `count_entities` and `properties_unique` all go through
 * `bim.*`, which is this adapter. Folding at tool level would mean each tool
 * re-implementing it — and `query_entities`' property filters would have to
 * re-implement the *filter*, which is exactly where a half-fold does the most
 * damage: a query for the value just written must find it.
 *
 * `related` folds too (#2014), and with it every containment answer the SDK
 * builds on top of it — `bim.storey`, `bim.path`, `bim.contains`,
 * `bim.decomposes`. A queued `IfcRelContainedInSpatialStructure` is how an agent
 * places something over MCP, so ignoring it was ignoring a write.
 *
 * Exact `relationships().relations` rows are folded through the same overlay.
 * Legacy projections and geometry rebuild on `model_load` after a save.
 */

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
  QueryBackendMethods,
  QueryDescriptor,
} from '@ifc-lite/sdk';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  extractAllEntityAttributes,
  extractClassificationsOnDemand,
  extractDocumentsOnDemand,
  extractMaterialsOnDemand,
  extractRelationshipsOnDemand,
  extractExactRelatedIds,
  expandTypes,
  QUERY_REL_TYPE_MAP,
  extractTypePropertiesOnDemand,
  isQueryableObjectType,
} from '@ifc-lite/parser';
import { attributeNamesForSchema } from './schema-tables.js';
import { EntityNode, matchesPropertyFilter } from '@ifc-lite/query';

import type { CreatedEntity, PendingOverlay } from './overlay.js';
import { authoredValue } from './authored-attribute-value.js';
import { foldRelationshipRows } from './backend-query-relationships.js';
// `expandTypes` used to be defined here; it now comes from `@ifc-lite/parser`,
// shared with the other query backends (see `query-backend-maps.ts`). Re-exported
// so this module's consumers are unaffected by where it lives.
export { expandTypes };

/**
 * Which classes an unfiltered query answers with.
 *
 * Thin alias: the predicate is schema logic and lives in `@ifc-lite/parser`, so
 * the CLI and MCP backends cannot drift apart on it. Kept as a named export
 * here because both packages already publish it under this name.
 */
export const isProductType = isQueryableObjectType;

function createdEntityData(created: CreatedEntity, ref: EntityRef, store: IfcDataStore): EntityData {
  const names = attributeNamesForSchema(created.ifcType, store.schemaVersion);
  const objectType = authoredValue(created.attributes[names.indexOf('ObjectType')]);
  return {
    ref,
    globalId: created.globalId,
    name: created.name ?? '',
    type: created.ifcType,
    description: created.description ?? '',
    objectType: typeof objectType === 'string' ? objectType : '',
  };
}

/**
 * Build the query adapter over a store, folding whatever `overlay()` returns at
 * call time. `overlay` is a getter, not a value: the backend creates its
 * `MutablePropertyView` lazily on the first mutation, so a session that is only
 * ever read gets `null` on every call and keeps the original store-only path.
 */
export function createQueryAdapter(
  store: IfcDataStore,
  modelId: string,
  overlay: () => PendingOverlay | null,
): QueryBackendMethods {
  function entityData(ref: EntityRef): EntityData | null {
    const pending = overlay();
    if (pending?.deleted.has(ref.expressId)) return null;
    const created = pending?.createdEntity(ref.expressId);
    if (created) return createdEntityData(created, ref, store);
    if (!store.entityIndex.byId.has(ref.expressId)) return null;
    const node = new EntityNode(store, ref.expressId);
    const type = node.type;
    if (!type || type === 'Unknown') return null;
    return withOverrides({
      ref,
      globalId: node.globalId,
      name: node.name,
      type,
      description: node.description,
      objectType: node.objectType,
    }, pending, ref.expressId);
  }

  function withOverrides(data: EntityData, pending: PendingOverlay | null, expressId: number): EntityData {
    if (!pending) return data;
    const overrides = pending.attributes(expressId);
    const positional = pending.positionalAttributes(expressId);
    if (overrides.size === 0 && positional.size === 0) return data;
    const next = {
      ...data,
      name: overrides.get('Name') ?? data.name,
      description: overrides.get('Description') ?? data.description,
      objectType: overrides.get('ObjectType') ?? data.objectType,
    };
    const exactType = store.entities.getTypeName(expressId) || data.type;
    const names = attributeNamesForSchema(exactType, store.schemaVersion);
    for (const [index, value] of positional) {
      const authored = authoredValue(value);
      const isUnset = value == null || (typeof value === 'string' && ['', '$', '*'].includes(value.trim()));
      const text = typeof authored === 'string' ? authored : isUnset ? '' : null;
      if (text === null) continue;
      if (names[index] === 'Name') next.name = text;
      else if (names[index] === 'Description') next.description = text;
      else if (names[index] === 'ObjectType') next.objectType = text;
    }
    return next;
  }
  function properties(ref: EntityRef, captured?: PendingOverlay | null): PropertySetData[] {
    // `captured` lets a caller that already has the overlay pass it in rather
    // than have it rebuilt per entity — the filter loop in `entities()` runs
    // this once per candidate row.
    const pending = captured !== undefined ? captured : overlay();
    // An entity this session deleted answers nothing, as `entityData` and
    // `entities` already have it answer nothing (#2014 review).
    if (pending?.deleted.has(ref.expressId)) return [];
    // `getForEntity` reads the same on-demand extraction the store would, then
    // applies the overlay on top — so it is the whole answer, not the delta.
    const psets = pending
      ? pending.propertySets(ref.expressId)
      : new EntityNode(store, ref.expressId).properties();
    return psets.map((pset) => ({
      name: pset.name,
      globalId: pset.globalId,
      properties: pset.properties.map((p) => ({ name: p.name, type: p.type, value: p.value as string | number | boolean | null })),
    }));
  }

  function quantities(ref: EntityRef): QuantitySetData[] {
    const pending = overlay();
    if (pending?.deleted.has(ref.expressId)) return [];
    const qsets = pending
      ? pending.quantitySets(ref.expressId)
      : new EntityNode(store, ref.expressId).quantities();
    return qsets.map((qset) => ({
      name: qset.name,
      quantities: qset.quantities.map((q) => ({ name: q.name, type: q.type, value: q.value })),
    }));
  }

  function attributes(ref: EntityRef): EntityAttributeData[] {
    const pending = overlay();
    if (pending?.deleted.has(ref.expressId)) return [];
    const created = pending?.createdEntity(ref.expressId);
    const base = created
      // Not in the store, so there is nothing to extract: name the authored
      // positional list from the schema instead. Cross-schema, because a created
      // IFC2X3 or IFC4X3 class is not in the IFC4 codegen pin (#2003).
      ? namedAuthoredAttributes(created)
      : extractAllEntityAttributes(store, ref.expressId);
    if (!pending) return base;
    const overrides = pending.attributes(ref.expressId);
    const positional = pending.positionalAttributes(ref.expressId);
    if (overrides.size === 0 && positional.size === 0) return base;
    // Overwrite what the base carries, then append what it does not. The append
    // is the half that was missing (#2014): `extractAllEntityAttributes` omits
    // an attribute whose stored value is `$`, so setting a previously-unset
    // `Description` changed the top-level field while this list still denied it
    // — one payload contradicting itself. Appended names go last; the list is
    // name-keyed and its order is not positional (the base already drops nulls).
    const merged = new Map(base.map((attribute) => [attribute.name, attribute.value]));
    const writes = new Map<string, unknown>(overrides);
    const exactType = created?.ifcType ?? store.entities.getTypeName(ref.expressId);
    const names = attributeNamesForSchema(exactType, store.schemaVersion);
    for (const [index, value] of positional) {
      const name = names[index];
      if (name) writes.set(name, value);
    }
    for (const [name, value] of writes) {
      const authored = authoredValue(value);
      if (authored === undefined) merged.delete(name);
      else merged.set(name, authored);
    }
    return [...merged].map(([name, value]) => ({ name, value }));
  }

  function namedAuthoredAttributes(created: CreatedEntity): EntityAttributeData[] {
    // The *model's* schema, not the IFC4 pin. `IfcRelCoversSpaces` names slot 4
    // `RelatedSpace` in IFC2X3 and `RelatingSpace` in IFC4, so the pinned answer
    // reported a name the file would not serialise. Falls back to the parser's
    // cross-schema list when the declared schema does not carry the class.
    const names = attributeNamesForSchema(created.ifcType, store.schemaVersion);
    const out: EntityAttributeData[] = [];
    for (let i = 0; i < created.attributes.length; i++) {
      const value = authoredValue(created.attributes[i]);
      if (value === undefined) continue;
      // No synthetic `Attribute7` names: `bim.attributes` is a list of IFC
      // EXPRESS attribute names, and an invented one is not one. A payload
      // longer than the schema knows about is the caller's to explain.
      const name = names[i];
      if (name === undefined) continue;
      out.push({ name, value });
    }
    return out;
  }

  return {
    entities(descriptor: QueryDescriptor): EntityData[] {
      const pending = overlay();
      const requested = descriptor.types && descriptor.types.length > 0
        ? expandTypes(descriptor.types, store.schemaVersion)
        : null;

      const entityIds: number[] = [];
      if (requested) {
        for (const type of requested) {
          const typeIds = store.entityIndex.byType.get(type) ?? [];
          for (const eid of typeIds) entityIds.push(eid);
        }
      } else {
        for (const [typeName, ids] of store.entityIndex.byType) {
          if (isProductType(typeName)) {
            for (const eid of ids) entityIds.push(eid);
          }
        }
      }

      const results: EntityData[] = [];
      for (const expressId of entityIds) {
        if (expressId === 0) continue;
        if (pending?.deleted.has(expressId)) continue;
        const node = new EntityNode(store, expressId);
        results.push(withOverrides({
          ref: { modelId, expressId },
          globalId: node.globalId,
          name: node.name,
          type: node.type,
          description: node.description,
          objectType: node.objectType,
        }, pending, expressId));
      }
      // Queued entities join the same result set under the same type rules, so
      // an agent that creates a wall and then queries for walls finds it.
      // `createdAll`, not `created`: `model_info` and `count_entities` count
      // every queued entity, so a typed query over the same class has to list
      // every one of them or the two contradict each other about what exists
      // (#2014). A queued entity with no GlobalId is still an entity; callers
      // address it by the `expressId` every row carries.
      const wanted = requested ? new Set(requested) : null;
      for (const created of pending?.createdAll ?? []) {
        const key = created.ifcType.toUpperCase();
        if (wanted ? !wanted.has(key) : !isProductType(key)) continue;
        results.push(withOverrides(
          createdEntityData(created, { modelId, expressId: created.expressId }, store),
          pending,
          created.expressId,
        ));
      }

      let filtered = results;
      if (descriptor.filters && descriptor.filters.length > 0) {
        const propsCache = new Map<number, PropertySetData[]>();
        const cachedProps = (ref: EntityRef): PropertySetData[] => {
          let cached = propsCache.get(ref.expressId);
          if (!cached) {
            cached = properties(ref, pending);
            propsCache.set(ref.expressId, cached);
          }
          return cached;
        };
        // A `Qto_` filter (or any psetName with no matching property set)
        // falls back to quantity sets — see `matchesPropertyFilter` in
        // `@ifc-lite/query`'s `property-filter-match.ts`. Without this, a
        // `Qto_WallBaseQuantities.NetVolume>1` filter (e.g. from the `#4094`
        // selector adapter's `.select()`/`selector` param) silently matched
        // zero entities even when the quantity was present.
        const qsetsCache = new Map<number, QuantitySetData[]>();
        const cachedQuantities = (ref: EntityRef): QuantitySetData[] => {
          let cached = qsetsCache.get(ref.expressId);
          if (!cached) {
            cached = quantities(ref);
            qsetsCache.set(ref.expressId, cached);
          }
          return cached;
        };
        for (const filter of descriptor.filters) {
          filtered = filtered.filter((entity) =>
            matchesPropertyFilter(cachedProps(entity.ref), filter, cachedQuantities(entity.ref))
          );
        }
      }
      // `&&` alone lets a NaN offset/limit through silently: every NaN
      // comparison is false, so `descriptor.offset > 0` was falsy and the
      // guard did nothing -- a caller that computed a bad value (e.g.
      // `Number(userInput)` on a non-numeric string) got back MORE rows
      // than asked for, with no error. The same falsy-zero shape made
      // `limit: 0` ("no rows") silently mean "every row" instead. Fail
      // loudly on a non-finite or negative value instead of quietly
      // serving the wrong slice, matching the misconfigured-caller
      // convention this adapter already uses elsewhere (see the `add*`
      // stubs in headless-backend.ts). `limit: 0` is now a deliberate
      // empty result.
      //
      // No built-in MCP tool reaches this today: `query_entities`
      // (tools/query.ts) validates `limit`/`offset` as JSON-Schema
      // integers before its handler runs and does its own pagination via
      // `paginate()` rather than chaining `.limit()/.offset()` on the
      // query builder. This guards the public SDK path instead --
      // `HeadlessLikeBackend` is exported from `./index.js` and
      // `./browser.js` for programmatic use, and an embedder driving it
      // through `@ifc-lite/sdk`'s fluent `QueryBuilder` reaches
      // `descriptor.limit`/`descriptor.offset` directly. Same shape as
      // the CLI's `headless-backend.ts` (#2298) -- a parallel
      // implementation, not a shared import, so it needed its own fix.
      if (descriptor.offset != null) {
        if (!Number.isFinite(descriptor.offset) || descriptor.offset < 0) {
          throw new Error(`Invalid offset: ${descriptor.offset} (must be a non-negative finite number)`);
        }
        if (descriptor.offset > 0) filtered = filtered.slice(descriptor.offset);
      }
      if (descriptor.limit != null) {
        if (!Number.isFinite(descriptor.limit) || descriptor.limit < 0) {
          throw new Error(`Invalid limit: ${descriptor.limit} (must be a non-negative finite number)`);
        }
        filtered = filtered.slice(0, descriptor.limit);
      }
      return filtered;
    },
    // Headless contexts have no interactive viewer filter, so there is never an
    // "active filter" to report (issue #1107).
    entitiesMatchingActiveFilter: () => null,
    entityData,
    attributes,
    properties: (ref: EntityRef) => properties(ref),
    quantities,
    classifications(ref: EntityRef): ClassificationData[] {
      return extractClassificationsOnDemand(store, ref.expressId);
    },
    materials(ref: EntityRef): MaterialData | null {
      return extractMaterialsOnDemand(store, ref.expressId);
    },
    typeProperties(ref: EntityRef): TypePropertiesData | null {
      const info = extractTypePropertiesOnDemand(store, ref.expressId);
      if (!info) return null;
      return {
        typeName: info.typeName,
        typeId: info.typeId,
        properties: info.properties.map((pset) => ({
          name: pset.name,
          globalId: pset.globalId,
          properties: pset.properties.map((p) => ({ name: p.name, type: p.type, value: p.value as string | number | boolean | null })),
        })),
      };
    },
    documents(ref: EntityRef): DocumentData[] {
      return extractDocumentsOnDemand(store, ref.expressId);
    },
    relationships(ref: EntityRef): EntityRelationshipsData {
      const result = extractRelationshipsOnDemand(store, ref.expressId);
      const pending = overlay();
      if (!pending) return result;
      return foldRelationshipRows(result, pending, ref, entityData);
    },
    /**
     * Containment, aggregation and typing, with the session's queued edits
     * applied (#2014).
     *
     * This is the seam every containment answer already passes through:
     * `bim.storey`, `bim.path`, `bim.contains`, `bim.decomposes` and
     * `bim.containedIn` are all thin wrappers over it. Folding here is what
     * stopped `query_entities(in_storey)` from dropping an entity that the same
     * session had just created *and* placed with a queued
     * `IfcRelContainedInSpatialStructure` — a query that returns an entity
     * without the filter and drops it with one reads as a wrong storey rather
     * than a missing fold.
     *
     * Three rules, in order:
     *
     * 1. A parsed edge is dropped when the session deleted the `IfcRel…` record
     *    that produced it. The graph carries `relationshipId` per edge, so this
     *    is exact rather than inferred.
     * 2. An edge to or from a tombstoned entity is dropped. Deleting a storey
     *    has to stop answering "this wall is in that storey".
     * 3. Queued relationships are added. Deleting a queued relationship forgets
     *    it outright, so there is no tombstone case to handle on this side.
     *
     * `forward` walks Relating → Related (a storey to its elements, a whole to
     * its parts); `inverse` walks back.
     */
    related(ref: EntityRef, relType: string, direction: 'forward' | 'inverse'): EntityRef[] {
      const relEnum = QUERY_REL_TYPE_MAP[relType];
      if (relEnum === undefined) return [];
      const pending = overlay();
      // A deleted entity relates to nothing (#2014 review).
      if (pending?.deleted.has(ref.expressId)) return [];
      const out: number[] = [];
      const seen = new Set<number>();
      const take = (expressId: number): void => {
        if (pending?.deleted.has(expressId) || seen.has(expressId)) return;
        seen.add(expressId);
        out.push(expressId);
      };
      const isDeleted = pending
        ? (id: number) => pending.deleted.has(id) || pending.supersededRelationshipIds.has(id)
        : () => false;
      for (const id of extractExactRelatedIds(store, ref.expressId, relType, direction, isDeleted)) take(id);
      for (const edge of pending?.relationshipEdges(ref.expressId, relType) ?? []) {
        if (edge.direction === direction) take(edge.targetId);
      }
      return out.map((expressId: number) => ({ modelId: ref.modelId, expressId }));
    },
  };
}
