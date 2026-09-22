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
import { EntityNode, findAllPropertiesInSets, compareFilterValue } from '@ifc-lite/query';
import { getModelForRef, getAllModelEntries } from './model-compat.js';
import {
  extractAllEntityAttributes,
  extractClassificationsOnDemand,
  extractMaterialsOnDemand,
  extractTypePropertiesOnDemand,
  extractDocumentsOnDemand,
  extractRelationshipsOnDemand,
  extractExactRelatedIds,
  expandTypes,
  QUERY_REL_TYPE_MAP,
  resolveEffectiveEntityRecord,
} from '@ifc-lite/parser';
import { applyAttributeMutationsToEntityData, getMutationViewForModel, mergeAttributeMutations } from './mutation-view.js';
import { effectiveMutationRelationships, foldMutationRelated } from './query-overlay-relations.js';
import { overlayProperties, overlayQuantities } from './query-adapter-overlay.js';
import { foldRelationshipData } from './query-relationship-fold.js';
import { isProductType } from './query-entity-filter.js';
import { evaluateFilterGroups } from '../../lib/search/filter-evaluate-groups.js';
import { totalRuleCount } from '../../lib/search/filter-groups.js';
import { definedModelTagIdsOf } from '../../lib/model-tags/evaluator-models.js';

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

    const view = getMutationViewForModel(store, ref.modelId);
    if (view?.isDeleted(ref.expressId)) return null;
    const created = view?.getNewEntity(ref.expressId);
    if (created && view) {
      // Effective class + name-relaid attributes, exactly as export writes them.
      const { type, attributes, names } = resolveEffectiveEntityRecord(created, {
        retype: view.getEntityTypeMutation(ref.expressId)?.newType,
        named: view.getAttributeMutationsForEntity(ref.expressId).map(({ name, value }) => [name, value] as const),
        positional: view.getPositionalMutationsForEntity(ref.expressId) ?? [],
      }, model.ifcDataStore.schemaVersion);
      const text = (name: string): string => {
        const value = attributes[names.indexOf(name)];
        if (typeof value !== 'string' || value === '$' || value === '*') return '';
        const trimmed = value.trim();
        return trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")
          ? trimmed.slice(1, -1).replace(/''/g, "'")
          : trimmed;
      };
      return { ref, globalId: text('GlobalId'), name: text('Name'), type,
        description: text('Description'), objectType: text('ObjectType') };
    }
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

    // The overlay is the whole answer once it exists (see query-adapter-overlay.ts).
    const overlaid = overlayProperties(getMutationViewForModel(store, ref.modelId), ref);
    if (overlaid) return overlaid;

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

    const overlaid = overlayQuantities(getMutationViewForModel(store, ref.modelId), ref);
    if (overlaid) return overlaid;

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
    const view = getMutationViewForModel(store, ref.modelId);
    if (!view) return extractRelationshipsOnDemand(model.ifcDataStore, ref.expressId);
    return foldRelationshipData(model.ifcDataStore, view, ref, getEntityData);
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
        // Expand types to every schema-declared descendant (IfcWall →
        // IfcWallStandardCase, IfcBuildingElement → its concrete leaves).
        // Resolved against this model's own schema, plus the leaf spellings
        // that schema does not declare at all, so neither the FILE_SCHEMA
        // header alone nor a plain union across the bundled tables decides
        // what its records answer. The version argument is load-bearing:
        // buildingSMART re-parented entities between versions.
        entityIds = [];
        for (const type of expandTypes(descriptor.types, model.ifcDataStore.schemaVersion)) {
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
          // Any-match, not first-match (#3490): an entity can carry two
          // distinct same-named property sets (type + occurrence), so a
          // filter predicate passes when ANY of them satisfies the
          // condition, not just the first one found. compareFilterValue is
          // the shared comparison logic (unified across all QueryBackendMethods
          // implementations) so 'contains'/boolean normalization can't drift
          // between hosts; its `exists` branch is unconditional (a property
          // that parses to null still exists).
          const matchingProps = findAllPropertiesInSets(props, filter.psetName, filter.propName);
          if (matchingProps.length === 0) return false;
          if (filter.operator === 'exists') return true;
          return matchingProps.some(prop => compareFilterValue(prop.value, filter.operator, filter.value));
        });
      }
    }

    // `!= null` alone lets a NaN offset/limit through (neither null nor
    // undefined); a bare `> 0` then silently drops it instead of rejecting
    // it, and by the same reasoning silently ignored a deliberate `limit: 0`.
    // Matches `packages/cli/src/headless-backend.ts` and
    // `packages/mcp/src/backend-query.ts` — the three `QueryBackendMethods`
    // implementations of this same `QueryDescriptor` contract must agree.
    if (descriptor.offset != null) {
      if (!Number.isFinite(descriptor.offset) || descriptor.offset < 0) {
        throw new TypeError(`Invalid offset: ${descriptor.offset} (must be a non-negative finite number)`);
      }
      if (descriptor.offset > 0) filtered = filtered.slice(descriptor.offset);
    }
    if (descriptor.limit != null) {
      if (!Number.isFinite(descriptor.limit) || descriptor.limit < 0) {
        throw new TypeError(`Invalid limit: ${descriptor.limit} (must be a non-negative finite number)`);
      }
      filtered = filtered.slice(0, descriptor.limit);
    }

    return filtered;
  }

  /**
   * Entities matching the viewer's *active advanced filter* (the chip rules in
   * the Search modal's Filter tab), or `null` when no filter is active. Lets
   * scripted exports (e.g. the CSV quantity take-off) honour the current
   * filtered view instead of always exporting everything (issue #1107, item 11).
   *
   * Re-evaluates `searchFilter.groups` (OR-of-AND, #4904) per model with the synchronous evaluator —
   * the same logic that backs the modal — with no row cap, so the export covers
   * the full filtered set rather than the modal's display limit. Hidden/isolated
   * visibility is intentionally NOT consulted: the chosen semantics are
   * "active search/filter only".
   */
  function entitiesMatchingActiveFilter(): EntityData[] | null {
    const state = store.getState();
    const filter = state.searchFilter;
    if (!filter || totalRuleCount(filter.groups) === 0) return null;

    const results: EntityData[] = [];
    for (const [modelId, model] of getAllModelEntries(state)) {
      if (!model?.ifcDataStore) continue;
      const matched = evaluateFilterGroups(
        modelId,
        model.ifcDataStore,
        filter.groups,
        {
          limit: Number.MAX_SAFE_INTEGER,
          modelTagIds: state.modelTagAssignments.get(modelId),
          definedModelTagIds: definedModelTagIdsOf(state),
        },
      );
      for (const m of matched) {
        if (m.expressId === 0) continue;
        const node = new EntityNode(model.ifcDataStore, m.expressId);
        results.push(applyAttributeMutationsToEntityData(store, modelId, m.expressId, {
          ref: { modelId, expressId: m.expressId },
          globalId: node.globalId,
          name: node.name,
          type: node.type,
          description: node.description,
          objectType: node.objectType,
        }));
      }
    }
    return results;
  }

  return {
    entities: queryEntities,
    entitiesMatchingActiveFilter,
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
      const relEnum = QUERY_REL_TYPE_MAP[relType];
      if (relEnum === undefined) return [];
      const view = getMutationViewForModel(store, ref.modelId);
      if (view?.isDeleted(ref.expressId)) return [];
      const seen = new Set<number>();
      const targets: number[] = [];
      const take = (expressId: number) => {
        if (view?.isDeleted(expressId) || seen.has(expressId)) return;
        seen.add(expressId);
        targets.push(expressId);
      };
      const effective = view ? effectiveMutationRelationships(model.ifcDataStore, view) : null;
      for (const target of extractExactRelatedIds(model.ifcDataStore, ref.expressId, relType, direction,
        id => view?.isDeleted(id) === true || effective?.supersededSourceIds.has(id) === true)) take(target);
      if (view) for (const target of foldMutationRelated(model.ifcDataStore, view, relType, direction, ref.expressId)) take(target);
      return targets.map((expressId) => ({ modelId: ref.modelId, expressId }));
    },
  };
}
