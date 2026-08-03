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
 * What is deliberately not folded: `relationships`, whose voids / fills / groups
 * / connections come from a parser-side extractor with no overlay seam, and the
 * geometry the clash and viewer tools read. Those are rebuilt on the next
 * `model_load` after a save.
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
  extractTypePropertiesOnDemand,
} from '@ifc-lite/parser';
import { attributeNamesForSchema } from './schema-tables.js';
import { EntityNode } from '@ifc-lite/query';
import { RelationshipType, IfcTypeEnum, IfcTypeEnumFromString } from '@ifc-lite/data';
import { stepText, type CreatedEntity, type PendingOverlay } from './overlay.js';

const REL_TYPE_MAP: Record<string, RelationshipType> = {
  IfcRelContainedInSpatialStructure: RelationshipType.ContainsElements,
  IfcRelAggregates: RelationshipType.Aggregates,
  IfcRelDefinesByType: RelationshipType.DefinesByType,
  IfcRelVoidsElement: RelationshipType.VoidsElement,
  IfcRelFillsElement: RelationshipType.FillsElement,
};

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

export function expandTypes(types: string[]): string[] {
  const result: string[] = [];
  for (const type of types) {
    const upper = type.toUpperCase();
    result.push(upper);
    const subtypes = IFC_SUBTYPES[upper];
    if (subtypes) for (const sub of subtypes) result.push(sub);
  }
  return result;
}

export function isProductType(type: string): boolean {
  const enumVal = IfcTypeEnumFromString(type);
  if (enumVal === IfcTypeEnum.Unknown) return false;
  const upper = type.toUpperCase();
  if (upper.startsWith('IFCREL')) return false;
  if (upper.startsWith('IFCPROPERTY')) return false;
  if (upper.startsWith('IFCQUANTITY')) return false;
  if (upper === 'IFCELEMENTQUANTITY') return false;
  if (upper.endsWith('TYPE')) return false;
  return true;
}

function normalizeBoolean(value: unknown): unknown {
  if (value === true || value === '.T.' || value === 'true' || value === 'TRUE') return 'true';
  if (value === false || value === '.F.' || value === 'false' || value === 'FALSE') return 'false';
  return value;
}

/** The overlay's answer for an entity it created, in `EntityData` shape. */
function createdEntityData(created: CreatedEntity, ref: EntityRef): EntityData {
  return {
    ref,
    globalId: created.globalId,
    name: created.name ?? '',
    type: created.ifcType,
    description: created.description ?? '',
    // Slot 4 is `ObjectType` on an IfcObject but `ApplicableOccurrence` on an
    // IfcTypeObject, so it is not read positionally. An `entity_set_attribute`
    // override still lands, applied by the caller.
    objectType: '',
  };
}

/**
 * One authored STEP attribute as a plain scalar, for `bim.attributes` on a
 * created entity.
 *
 * **Not `stepText`.** That helper answers "is this text?", and deliberately says
 * no to `#42` because its caller reads an entity's *Name* and must not mistake a
 * reference for one. Reusing it here dropped every structural attribute an agent
 * authored — `ObjectPlacement: '#40'` vanished from the readback (#2014). The
 * fix belongs on this side of the line, not in `stepText`: a reference *is* the
 * value of a structural attribute, and it is what will be serialised.
 *
 * Coercion mirrors the parsed path (`coerceRaw` in `@ifc-lite/query`) so a
 * created entity and a parsed one report the same shapes: `$`/`*`/`.U.`/`.X.`
 * are absent, `.T.`/`.F.` are booleans, other dotted tokens are bare enum names,
 * quoted text is unquoted.
 *
 * Lists are skipped — and so are they on the parsed path, where `coerceRaw`
 * answers null for an array. `EntityAttributeData.value` has no array form to
 * put one in, and reporting a created entity's `RelatedElements` while a parsed
 * entity's stays hidden would trade one inconsistency for another. The queued
 * relationships those lists express are read back through `related()` instead,
 * where they have somewhere to go.
 */
function authoredValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  // The authoring API's wrapper forms (`StoreEditor.addEntity`).
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const wrapper = value as { real?: number; typed?: { value?: string | number | boolean } };
    if (typeof wrapper.real === 'number') return wrapper.real;
    if (wrapper.typed && wrapper.typed.value !== undefined) return wrapper.typed.value;
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '$' || trimmed === '*') return undefined;
  if (trimmed === '.T.') return true;
  if (trimmed === '.F.') return false;
  if (trimmed === '.U.' || trimmed === '.X.') return undefined;
  if (trimmed.startsWith('#')) return trimmed;
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('.') && trimmed.endsWith('.')) return trimmed.slice(1, -1);
  return trimmed;
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
    if (created) return withOverrides(createdEntityData(created, ref), pending, ref.expressId);
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
    if (overrides.size === 0) return data;
    // `EntityData` has a slot for exactly these three; anything else the session
    // wrote (`Tag`) reaches the caller through `attributes()` below, which
    // carries the whole map.
    return {
      ...data,
      name: overrides.get('Name') ?? data.name,
      description: overrides.get('Description') ?? data.description,
      objectType: overrides.get('ObjectType') ?? data.objectType,
    };
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
    if (overrides.size === 0) return base;
    // Overwrite what the base carries, then append what it does not. The append
    // is the half that was missing (#2014): `extractAllEntityAttributes` omits
    // an attribute whose stored value is `$`, so setting a previously-unset
    // `Description` changed the top-level field while this list still denied it
    // — one payload contradicting itself. Appended names go last; the list is
    // name-keyed and its order is not positional (the base already drops nulls).
    const merged = base.map((attr) => {
      const written = overrides.get(attr.name);
      return written === undefined ? attr : { ...attr, value: written };
    });
    const present = new Set(merged.map((attr) => attr.name));
    for (const [name, value] of overrides) {
      if (!present.has(name)) merged.push({ name, value });
    }
    return merged;
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
        ? expandTypes(descriptor.types)
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
          createdEntityData(created, { modelId, expressId: created.expressId }),
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
        for (const filter of descriptor.filters) {
          filtered = filtered.filter((entity) => {
            const props = cachedProps(entity.ref);
            const pset = props.find((p) => p.name === filter.psetName);
            if (!pset) return false;
            const prop = pset.properties.find((p) => p.name === filter.propName);
            if (!prop) return false;
            if (filter.operator === 'exists') return true;
            const v = normalizeBoolean(prop.value);
            const f = normalizeBoolean(filter.value);
            switch (filter.operator) {
              case '=': return String(v) === String(f);
              case '!=': return String(v) !== String(f);
              case '>': return Number(v) > Number(f);
              case '<': return Number(v) < Number(f);
              case '>=': return Number(v) >= Number(f);
              case '<=': return Number(v) <= Number(f);
              case 'contains': return String(v).toLowerCase().includes(String(f).toLowerCase());
              default: return false;
            }
          });
        }
      }
      if (descriptor.offset && descriptor.offset > 0) filtered = filtered.slice(descriptor.offset);
      if (descriptor.limit && descriptor.limit > 0) filtered = filtered.slice(0, descriptor.limit);
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
      return extractRelationshipsOnDemand(store, ref.expressId);
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
      const relEnum = REL_TYPE_MAP[relType];
      if (relEnum === undefined) return [];
      const pending = overlay();
      // A deleted entity relates to nothing. Filtering only the far end left it
      // answering questions about itself (#2014 review).
      if (pending?.deleted.has(ref.expressId)) return [];
      const half = direction === 'forward' ? store.relationships.forward : store.relationships.inverse;
      const out: number[] = [];
      const seen = new Set<number>();
      const take = (expressId: number): void => {
        if (pending?.deleted.has(expressId) || seen.has(expressId)) return;
        seen.add(expressId);
        out.push(expressId);
      };
      for (const edge of half.getEdges(ref.expressId, relEnum)) {
        if (pending?.deleted.has(edge.relationshipId)) continue;
        take(edge.target);
      }
      for (const relation of pending?.queuedRelations(relType) ?? []) {
        if (direction === 'forward') {
          if (relation.relating !== ref.expressId) continue;
          for (const target of relation.related) take(target);
        } else if (relation.related.includes(ref.expressId)) {
          take(relation.relating);
        }
      }
      return out.map((expressId: number) => ({ modelId: ref.modelId, expressId }));
    },
  };
}
