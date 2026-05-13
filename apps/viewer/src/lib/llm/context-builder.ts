/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build model context from the current viewer state.
 * This context is injected into the system prompt so the LLM
 * knows what's currently loaded in the 3D viewer.
 */

import { useViewerStore } from '@/store';
import type { ModelContext } from './system-prompt.js';
import { IfcTypeEnum, type SpatialNode, type SpatialHierarchy } from '@ifc-lite/data';
import {
  extractClassificationsOnDemand,
  extractMaterialsOnDemand,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractTypeEntityOwnProperties,
  extractTypePropertiesOnDemand,
} from '@ifc-lite/parser';
import { resolveEntityRef } from '@/store/resolveEntityRef';

let cachedTypeCountsFingerprint = '';
let cachedTypeCounts: Record<string, number> = {};

function buildFingerprint(state: ReturnType<typeof useViewerStore.getState>): string {
  if (state.models.size > 0) {
    const items: string[] = [];
    for (const [id, model] of state.models) {
      const count = model.ifcDataStore?.entities.count ?? 0;
      items.push(`${id}:${count}`);
    }
    items.sort();
    return `federated|${items.join('|')}`;
  }

  const legacyCount = state.ifcDataStore?.entities.count ?? 0;
  return `legacy|${legacyCount}`;
}

function computeTypeCounts(state: ReturnType<typeof useViewerStore.getState>): Record<string, number> {
  const typeCounts: Record<string, number> = {};

  if (state.models.size > 0) {
    for (const [, model] of state.models) {
      const store = model.ifcDataStore;
      if (!store) continue;
      for (let i = 0; i < store.entities.count; i++) {
        const id = store.entities.expressId[i];
        const type = store.entities.getTypeName(id);
        if (type) typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      }
    }
    return typeCounts;
  }

  if (state.ifcDataStore) {
    const store = state.ifcDataStore;
    for (let i = 0; i < store.entities.count; i++) {
      const id = store.entities.expressId[i];
      const type = store.entities.getTypeName(id);
      if (type) typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    }
  }

  return typeCounts;
}

function collectStoreys(
  hierarchy: SpatialHierarchy | undefined,
  modelName?: string,
): NonNullable<ModelContext['storeys']> {
  if (!hierarchy?.project) return [];

  const result: NonNullable<ModelContext['storeys']> = [];
  const visit = (node: SpatialNode) => {
    if (node.type === IfcTypeEnum.IfcBuildingStorey) {
      result.push({
        modelName,
        name: node.name || 'Storey',
        elevation: node.elevation ?? hierarchy.storeyElevations.get(node.expressId) ?? 0,
        height: hierarchy.storeyHeights.get(node.expressId),
        elementCount: hierarchy.byStorey.get(node.expressId)?.length ?? node.elements.length,
      });
    }
    for (const child of node.children) visit(child);
  };

  visit(hierarchy.project);
  result.sort((a, b) => a.elevation - b.elevation);
  return result;
}

function getStoreForModel(
  state: ReturnType<typeof useViewerStore.getState>,
  modelId: string,
): { store: NonNullable<typeof state.ifcDataStore> | null; modelName?: string } {
  if (modelId === 'legacy') {
    return { store: state.ifcDataStore, modelName: 'Model' };
  }
  const model = state.models.get(modelId);
  return { store: model?.ifcDataStore ?? null, modelName: model?.name ?? modelId };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function collectSelectedEntities(state: ReturnType<typeof useViewerStore.getState>): NonNullable<ModelContext['selectedEntities']> {
  const refs = state.selectedEntities.length > 0
    ? state.selectedEntities
    : state.selectedEntity
      ? [state.selectedEntity]
      : state.selectedEntityIds.size > 0
        ? Array.from(state.selectedEntityIds).slice(0, 5).map((id) => resolveEntityRef(id))
        : [];

  return refs.slice(0, 5).flatMap((ref) => {
    const { store, modelName } = getStoreForModel(state, ref.modelId);
    if (!store) return [];

    const type = store.entities.getTypeName(ref.expressId) || 'Unknown';
    const name = store.entities.getName(ref.expressId) || `${type} #${ref.expressId}`;
    const storeyId = store.spatialHierarchy?.elementToStorey.get(ref.expressId);
    const storeyName = storeyId !== undefined ? (store.entities.getName(storeyId) || `Storey #${storeyId}`) : undefined;
    const storeyElevation = storeyId !== undefined ? store.spatialHierarchy?.storeyElevations.get(storeyId) : undefined;

    const rawPsets = extractPropertiesOnDemand(store, ref.expressId) as Array<{ name?: string; Name?: string }> | undefined;
    const rawQsets = extractQuantitiesOnDemand(store, ref.expressId) as Array<{ name?: string; Name?: string }> | undefined;
    const typeOwnPsets = extractTypeEntityOwnProperties(store, ref.expressId);
    const inheritedTypeProps = extractTypePropertiesOnDemand(store, ref.expressId);
    const rawMaterial = extractMaterialsOnDemand(store, ref.expressId);
    const rawClassifications = extractClassificationsOnDemand(store, ref.expressId);
    const instancePropertySets = uniqueStrings((rawPsets ?? []).map((pset) => pset.name ?? pset.Name));
    const ownTypePropertySets = uniqueStrings(typeOwnPsets.map((pset) => pset.name));
    const inheritedTypePropertySets = uniqueStrings((inheritedTypeProps?.properties ?? []).map((pset) => pset.name));
    const selectionKind = ownTypePropertySets.length > 0 ? 'type' : 'occurrence';
    const propertySets = (selectionKind === 'type' ? ownTypePropertySets : instancePropertySets).slice(0, 6);
    const typePropertySets = (selectionKind === 'type' ? [] : inheritedTypePropertySets).slice(0, 6);
    const quantitySets = (rawQsets ?? []).map((qset) => qset.name ?? qset.Name).filter((value): value is string => Boolean(value)).slice(0, 6);
    const materialName = rawMaterial?.name ?? rawMaterial?.materials?.[0]?.name;
    const classifications = rawClassifications
      .map((classification) => classification.identification ?? classification.name ?? classification.system)
      .filter((value): value is string => Boolean(value))
      .slice(0, 4);

    return [{
      modelName,
      name,
      type,
      selectionKind,
      globalId: store.entities.getGlobalId?.(ref.expressId),
      storeyName,
      storeyElevation,
      propertySets,
      typePropertySets,
      quantitySets,
      materialName,
      classifications,
    }];
  });
}

/**
 * Snapshot the current model context from the Zustand store.
 * Called before each LLM request to provide up-to-date context.
 */
export function getModelContext(): ModelContext {
  const state = useViewerStore.getState();

  const models: ModelContext['models'] = [];
  const storeys: NonNullable<ModelContext['storeys']> = [];
  const fingerprint = buildFingerprint(state);

  // Federated models
  if (state.models.size > 0) {
    for (const [, model] of state.models) {
      const entityCount = model.ifcDataStore?.entities.count ?? 0;
      models.push({
        name: model.name ?? 'Unknown',
        entityCount,
      });
      storeys.push(...collectStoreys(model.ifcDataStore?.spatialHierarchy, model.name ?? 'Unknown'));
    }
  }

  // Legacy single-model path
  if (models.length === 0 && state.ifcDataStore) {
    const store = state.ifcDataStore;
    models.push({
      name: 'Model',
      entityCount: store.entities.count,
    });
    storeys.push(...collectStoreys(store.spatialHierarchy, 'Model'));
  }

  if (fingerprint !== cachedTypeCountsFingerprint) {
    cachedTypeCounts = computeTypeCounts(state);
    cachedTypeCountsFingerprint = fingerprint;
  }

  // Selection count
  const selectedCount = state.selectedEntities.length > 0
    ? state.selectedEntities.length
    : state.selectedEntitiesSet.size > 0
      ? state.selectedEntitiesSet.size
      : state.selectedEntity
        ? 1
        : state.selectedEntityIds.size > 0
          ? state.selectedEntityIds.size
          : state.selectedEntityId !== null ? 1 : 0;
  const selectedEntities = collectSelectedEntities(state);

  return { models, typeCounts: cachedTypeCounts, selectedCount, storeys, selectedEntities };
}

/**
 * Parse a CSV string into an array of row objects.
 * Simple parser that handles quoted fields with commas.
 */
export function parseCSV(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const records = splitCSVRecords(text).filter((record) => record.trim().length > 0);
  if (records.length === 0) return { columns: [], rows: [] };

  // Parse header
  const columns = parseCSVLine(records[0]);

  // Parse rows
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < records.length; i++) {
    const values = parseCSVLine(records[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < columns.length; j++) {
      row[columns[j]] = values[j] ?? '';
    }
    rows.push(row);
  }

  return { columns, rows };
}

function splitCSVRecords(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const records: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === '"') {
      if (inQuotes && normalized[i + 1] === '"') {
        current += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === '\n' && !inQuotes) {
      records.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    records.push(current);
  }
  return records;
}

/** Parse a single CSV line, handling quoted fields */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',' || char === ';') {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}
