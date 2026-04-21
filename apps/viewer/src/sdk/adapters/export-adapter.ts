/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreApi } from './types.js';
import type { EntityRef, EntityData, PropertySetData, QuantitySetData, ExportBackendMethods } from '@ifc-lite/sdk';
import { EntityNode } from '@ifc-lite/query';
import { StepExporter, type StepExportOptions } from '@ifc-lite/export';
import { getModelForRef, LEGACY_MODEL_ID } from './model-compat.js';
import { applyAttributeMutationsToEntityData, getMutationViewForModel } from './mutation-view.js';
import { serializeScheduleToStep, type ScheduleExtraction, type IfcDataStore } from '@ifc-lite/parser';

/** Options for CSV export */
interface CsvOptions {
  columns: string[];
  separator?: string;
  filename?: string;
}


/** Options for IFC STEP export */
interface IfcExportOptions {
  schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3';
  filename?: string;
  includeMutations?: boolean;
  visibleOnly?: boolean;
}

/** Validate that a value is an IfcExportOptions object. */
function isIfcExportOptions(v: unknown): v is IfcExportOptions {
  if (v === null || typeof v !== 'object') return false;
  const options = v as IfcExportOptions;
  if (options.schema !== undefined && options.schema !== 'IFC2X3' && options.schema !== 'IFC4' && options.schema !== 'IFC4X3') return false;
  if (options.filename !== undefined && typeof options.filename !== 'string') return false;
  if (options.includeMutations !== undefined && typeof options.includeMutations !== 'boolean') return false;
  if (options.visibleOnly !== undefined && typeof options.visibleOnly !== 'boolean') return false;
  return true;
}

/**
 * Validate that a value is a CsvOptions object.
 */
function isCsvOptions(v: unknown): v is CsvOptions {
  if (v === null || typeof v !== 'object' || !('columns' in v)) return false;
  const columns = (v as CsvOptions).columns;
  if (!Array.isArray(columns)) return false;
  // Validate all column entries are strings
  return columns.every((c): c is string => typeof c === 'string');
}

/**
 * Validate that a value is an array of EntityRef objects.
 */
function isEntityRefArray(v: unknown): v is EntityRef[] {
  if (!Array.isArray(v)) return false;
  if (v.length === 0) return true;
  const first = v[0] as Record<string, unknown>;
  // Accept both raw EntityRef and entity proxy objects with .ref
  if ('modelId' in first && 'expressId' in first) {
    return typeof first.modelId === 'string' && typeof first.expressId === 'number';
  }
  if ('ref' in first && first.ref !== null && typeof first.ref === 'object') {
    const ref = first.ref as Record<string, unknown>;
    return typeof ref.modelId === 'string' && typeof ref.expressId === 'number';
  }
  return false;
}

/**
 * Normalize entity refs — entities from the sandbox may be EntityData
 * objects with a .ref property, or raw EntityRef { modelId, expressId }.
 */
function normalizeRefs(raw: unknown[]): EntityRef[] {
  return raw.map((item) => {
    const r = item as Record<string, unknown>;
    if (r.ref && typeof r.ref === 'object') {
      return r.ref as EntityRef;
    }
    return { modelId: r.modelId as string, expressId: r.expressId as number };
  });
}

export function resolveVisibilityFilterSets(
  state: StoreApi['getState'] extends () => infer T ? T : never,
  modelId: string,
  selectedExpressIds: Set<number>,
  entityCount: number,
): { visibleOnly: boolean; hiddenEntityIds: Set<number>; isolatedEntityIds: Set<number> | null } {
  const shouldLimitToSelection = selectedExpressIds.size < entityCount;
  const isLegacyModel = state.models.size === 0 && (modelId === LEGACY_MODEL_ID || modelId === 'legacy');
  const modelHidden = state.hiddenEntitiesByModel.get(modelId) ?? (isLegacyModel ? state.hiddenEntities : undefined);
  const modelIsolated = state.isolatedEntitiesByModel.get(modelId) ?? (isLegacyModel ? state.isolatedEntities : null);

  return {
    visibleOnly: shouldLimitToSelection,
    hiddenEntityIds: shouldLimitToSelection
      ? new Set<number>()
      : new Set<number>(modelHidden ?? []),
    isolatedEntityIds: shouldLimitToSelection
      ? selectedExpressIds
      : modelIsolated,
  };
}

/**
 * Escape a CSV cell value — wrap in quotes if it contains the separator,
 * double-quotes, or newlines.
 */
function escapeCsv(value: string, sep: string): string {
  if (value.includes(sep) || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Export adapter — implements CSV and JSON export directly.
 *
 * This adapter resolves entity data by dispatching to the query adapter
 * on the same LocalBackend, providing full export support for both
 * direct dispatch calls and SDK namespace usage.
 */
function toBlobPart(content: string | Uint8Array): BlobPart {
  if (typeof content === 'string') return content;
  const bytes = new Uint8Array(content.byteLength);
  bytes.set(content);
  return bytes;
}

export function createExportAdapter(store: StoreApi): ExportBackendMethods {
  /** Resolve entity data via the query subsystem */
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

  /** Resolve property sets for an entity */
  function getProperties(ref: EntityRef): PropertySetData[] {
    const state = store.getState();
    const model = getModelForRef(state, ref.modelId);
    if (!model?.ifcDataStore) return [];

    const node = new EntityNode(model.ifcDataStore, ref.expressId);
    return node.properties().map((pset: { name: string; globalId?: string; properties: Array<{ name: string; type: number; value: string | number | boolean | null }> }) => ({
      name: pset.name,
      globalId: pset.globalId,
      properties: pset.properties.map((p: { name: string; type: number; value: string | number | boolean | null }) => ({
        name: p.name,
        type: p.type,
        value: p.value,
      })),
    }));
  }

  /** Resolve quantity sets for an entity */
  function getQuantities(ref: EntityRef): QuantitySetData[] {
    const state = store.getState();
    const model = getModelForRef(state, ref.modelId);
    if (!model?.ifcDataStore) return [];

    const node = new EntityNode(model.ifcDataStore, ref.expressId);
    return node.quantities().map((qset: { name: string; quantities: Array<{ name: string; type: number; value: number }> }) => ({
      name: qset.name,
      quantities: qset.quantities.map((q: { name: string; type: number; value: number }) => ({
        name: q.name,
        type: q.type,
        value: q.value,
      })),
    }));
  }

  /** Resolve a single column value from entity data + properties + quantities.
   * Accepts both IFC PascalCase (Name, GlobalId) and legacy camelCase (name, globalId).
   * Dot-path columns (e.g. "Pset_WallCommon.FireRating" or "Qto_WallBaseQuantities.GrossVolume")
   * resolve against property sets first, then quantity sets. */
  function resolveColumnValue(
    data: EntityData,
    col: string,
    getProps: () => PropertySetData[],
    getQties: () => QuantitySetData[],
  ): string {
    // IFC schema attribute names (PascalCase) + legacy camelCase
    switch (col) {
      case 'Name': case 'name': return data.name;
      case 'Type': case 'type': return data.type;
      case 'GlobalId': case 'globalId': return data.globalId;
      case 'Description': case 'description': return data.description;
      case 'ObjectType': case 'objectType': return data.objectType;
      case 'modelId': return data.ref.modelId;
      case 'expressId': return String(data.ref.expressId);
    }

    // Property/Quantity path: "SetName.ValueName"
    const dotIdx = col.indexOf('.');
    if (dotIdx > 0) {
      const setName = col.slice(0, dotIdx);
      const valueName = col.slice(dotIdx + 1);

      // Try property sets first
      const psets = getProps();
      const pset = psets.find(p => p.name === setName);
      if (pset) {
        const prop = pset.properties.find(p => p.name === valueName);
        if (prop?.value != null) return String(prop.value);
      }

      // Fall back to quantity sets
      const qsets = getQties();
      const qset = qsets.find(q => q.name === setName);
      if (qset) {
        const qty = qset.quantities.find(q => q.name === valueName);
        if (qty?.value != null) return String(qty.value);
      }

      return '';
    }

    return '';
  }

  return {
    csv(rawRefs: unknown, rawOptions: unknown) {
      if (!isEntityRefArray(rawRefs)) {
        throw new Error('export.csv: first argument must be an array of entity references');
      }
      if (!isCsvOptions(rawOptions)) {
        throw new Error('export.csv: second argument must be { columns: string[], separator?: string }');
      }

      const refs = normalizeRefs(rawRefs);
      const options = rawOptions;
      const sep = options.separator ?? ',';
      const rows: string[][] = [];

      // Header row
      rows.push(options.columns);

      // Data rows
      for (const ref of refs) {
        const data = getEntityData(ref);
        if (!data) continue;

        // Lazy-load properties/quantities only if a column needs them
        let cachedProps: PropertySetData[] | null = null;
        const getProps = (): PropertySetData[] => {
          if (!cachedProps) cachedProps = getProperties(ref);
          return cachedProps;
        };
        let cachedQties: QuantitySetData[] | null = null;
        const getQties = (): QuantitySetData[] => {
          if (!cachedQties) cachedQties = getQuantities(ref);
          return cachedQties;
        };

        const row = options.columns.map(col => resolveColumnValue(data, col, getProps, getQties));
        rows.push(row);
      }

      const csvString = rows.map(r => r.map(cell => escapeCsv(cell, sep)).join(sep)).join('\n');

      // If filename specified, trigger browser download
      if (options.filename) {
        triggerDownload(csvString, options.filename, 'text/csv;charset=utf-8;');
      }

      return csvString;
    },

    json(rawRefs: unknown, columns: unknown) {
      if (!isEntityRefArray(rawRefs)) {
        throw new Error('export.json: first argument must be an array of entity references');
      }
      if (!Array.isArray(columns)) {
        throw new Error('export.json: second argument must be a string[] of column names');
      }

      const refs = normalizeRefs(rawRefs);
      const result: Record<string, unknown>[] = [];

      for (const ref of refs) {
        const data = getEntityData(ref);
        if (!data) continue;

        let cachedProps: PropertySetData[] | null = null;
        const getProps = (): PropertySetData[] => {
          if (!cachedProps) cachedProps = getProperties(ref);
          return cachedProps;
        };
        let cachedQties: QuantitySetData[] | null = null;
        const getQties = (): QuantitySetData[] => {
          if (!cachedQties) cachedQties = getQuantities(ref);
          return cachedQties;
        };

        const row: Record<string, unknown> = {};
        for (const col of columns as string[]) {
          const value = resolveColumnValue(data, col, getProps, getQties);
          // Try to parse numeric values
          const numVal = Number(value);
          row[col] = value === '' ? null : !isNaN(numVal) && value.trim() !== '' ? numVal : value;
        }
        result.push(row);
      }

      return result;
    },

    ifc(rawRefs: unknown, rawOptions: unknown) {
      const candidateOptions = rawOptions ?? {};
      if (!isEntityRefArray(rawRefs)) {
        throw new Error('export.ifc: first argument must be an array of entity references');
      }
      if (!isIfcExportOptions(candidateOptions)) {
        throw new Error('export.ifc: second argument must be { schema?: IFC2X3|IFC4|IFC4X3, filename?: string, includeMutations?: boolean, visibleOnly?: boolean }');
      }

      const refs = normalizeRefs(rawRefs);
      if (refs.length === 0) {
        throw new Error('export.ifc: expected at least one entity reference');
      }

      const modelIds = new Set(refs.map(ref => ref.modelId));
      if (modelIds.size !== 1) {
        throw new Error('export.ifc: all entity references must belong to the same model');
      }

      const modelId = refs[0].modelId;
      const state = store.getState();
      const model = getModelForRef(state, modelId);
      if (!model?.ifcDataStore) {
        throw new Error(`export.ifc: model '${modelId}' is not loaded`);
      }

      if (model.ifcDataStore.schemaVersion === 'IFC5') {
        throw new Error('export.ifc: IFC5 export is not supported by STEP exporter, use IFC2X3/IFC4/IFC4X3 models');
      }

      const options = candidateOptions;
      const selectedExpressIds = new Set(refs.map(ref => ref.expressId));
      const visibilityFilters = resolveVisibilityFilterSets(
        state,
        modelId,
        selectedExpressIds,
        model.ifcDataStore.entityCount,
      );
      const visibleOnly = options.visibleOnly === true || visibilityFilters.visibleOnly;
      const hiddenEntityIds = visibleOnly ? visibilityFilters.hiddenEntityIds : new Set<number>();
      const isolatedEntityIds = visibleOnly ? visibilityFilters.isolatedEntityIds : null;

      const exporter = new StepExporter(
        model.ifcDataStore,
        options.includeMutations === false ? undefined : getMutationViewForModel(store, modelId) ?? undefined,
      );
      // Include georeferencing mutations if present
      const georefMutations = options.includeMutations !== false
        ? state.georefMutations?.get(modelId) ?? undefined
        : undefined;

      const exportOptions: StepExportOptions = {
        schema: options.schema ?? model.ifcDataStore.schemaVersion,
        includeGeometry: true,
        includeProperties: true,
        includeQuantities: true,
        includeRelationships: true,
        applyMutations: options.includeMutations ?? true,
        visibleOnly,
        hiddenEntityIds,
        isolatedEntityIds,
        georefMutations,
      };

      const exportedContent = exporter.export(exportOptions).content;

      // Splice any in-memory schedule (parsed-and-cached, or generated via the
      // Gantt panel's "Generate from storeys" dialog) into the STEP output.
      // The serializer emits IFC4-conformant IfcWorkSchedule / IfcTask /
      // IfcTaskTime / IfcRelSequence / IfcRelAssignsToProcess /
      // IfcRelAssignsToControl / IfcRelNests lines that any conformant viewer
      // (incl. ifc-lite itself on re-import) will parse natively.
      //
      // STEP exports are text by contract; the binary path is reserved for
      // future formats. We pass through Uint8Array unchanged so the contract
      // doesn't silently change.
      if (typeof exportedContent !== 'string') return exportedContent;
      return injectScheduleIntoStep(
        exportedContent,
        state.scheduleData ?? null,
        model.ifcDataStore as IfcDataStore,
      );
    },

    download(content: string | Uint8Array, filename: string, mimeType?: string) {
      triggerDownload(content, filename, mimeType ?? 'text/plain');
      return undefined;
    },
  };
}

/**
 * Splice an in-memory `ScheduleExtraction` into a STEP file's DATA section.
 *
 * Two cases:
 *   • The schedule was *parsed* from the same source IFC (every task has a
 *     positive expressId — it already exists in the STEP body, so we leave
 *     the file alone).
 *   • The schedule was *generated* (e.g. via the Gantt panel's "Generate
 *     from storeys" dialog — task.expressId === 0). We allocate fresh
 *     express IDs starting just past the model's current maximum, run
 *     `serializeScheduleToStep` to produce IFC4-conformant lines, and splice
 *     them in just before the trailing `ENDSEC;`. The caller still gets a
 *     well-formed `ISO-10303-21;` ... `END-ISO-10303-21;` string.
 *
 * We also use the source model's existing IfcOwnerHistory (when present)
 * for the inserted entities so they share ownership metadata.
 */
export function injectScheduleIntoStep(
  stepContent: string,
  scheduleData: ScheduleExtraction | null,
  ifcDataStore: IfcDataStore,
): string {
  if (!scheduleData || scheduleData.tasks.length === 0) return stepContent;

  // Partition tasks: only tasks the user generated locally (expressId <= 0 or
  // missing) need to be serialized. Tasks with a real expressId are already
  // emitted as part of the normal export and must not be duplicated.
  // Partitioning lets mixed schedules (e.g. user appended a generated task to
  // a parsed schedule) still round-trip the new tail.
  const generatedTasks = scheduleData.tasks.filter(t => !t.expressId || t.expressId <= 0);
  if (generatedTasks.length === 0) return stepContent;

  // Only forward sequences whose endpoints are both in the generated set —
  // re-emitting a sequence that references an already-exported task would
  // produce a duplicate IfcRelSequence on re-import.
  const generatedTaskGids = new Set(generatedTasks.map(t => t.globalId));
  const generatedSequences = scheduleData.sequences.filter(
    s => generatedTaskGids.has(s.relatingTaskGlobalId) && generatedTaskGids.has(s.relatedTaskGlobalId),
  );

  // Work schedules: keep only those whose entire task membership was
  // generated (or that are fresh — no expressId). A parsed work schedule
  // already exists in the STEP body.
  const generatedWorkSchedules = scheduleData.workSchedules.filter(ws => !ws.expressId || ws.expressId <= 0);

  const partitioned: ScheduleExtraction = {
    hasSchedule: true,
    workSchedules: generatedWorkSchedules,
    tasks: generatedTasks,
    sequences: generatedSequences,
  };

  // Pick a fresh express-ID starting point. The exporter renumbers in order,
  // so scanning the highest `#NNN=` in the output is the safest source of
  // truth (even if the source data store had a different max id space).
  const maxId = findMaxExpressId(stepContent);
  const ownerHistoryId = findFirstOwnerHistoryId(stepContent) ?? undefined;

  // Resolve product GlobalIds → expressIds against the live data store so
  // generated `IfcRelAssignsToProcess` entries point at real geometry.
  const resolveProduct = (gid: string): number | undefined => {
    if (!gid) return undefined;
    return ifcDataStore.entities?.getExpressIdByGlobalId?.(gid) ?? undefined;
  };

  const result = serializeScheduleToStep(partitioned, {
    nextId: maxId + 1,
    ownerHistoryId,
    resolveProductExpressId: resolveProduct,
  });

  if (result.lines.length === 0) return stepContent;

  // Splice the new lines in just before the closing ENDSEC of the DATA
  // section. We anchor on the LAST `ENDSEC;` since the header section also
  // ends with one — we want the data-section end.
  const endSecIdx = stepContent.lastIndexOf('ENDSEC;');
  if (endSecIdx < 0) {
    // Malformed STEP — surface the original file unchanged rather than
    // corrupting it.
    console.warn('[export] schedule injection: ENDSEC not found in STEP output');
    return stepContent;
  }

  const head = stepContent.slice(0, endSecIdx);
  const tail = stepContent.slice(endSecIdx);
  return `${head}${result.lines.join('\n')}\n${tail}`;
}

/** Scan the STEP body for the highest `#N=` declaration. Returns 0 when none. */
function findMaxExpressId(stepContent: string): number {
  let max = 0;
  // Pattern: line starts with `#NNN=` (newline-anchored to avoid matching
  // refs inside attribute lists).
  const regex = /(?:^|\n)\s*#(\d+)\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(stepContent)) !== null) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/** Find the first IfcOwnerHistory's express ID in the STEP file, if any. */
function findFirstOwnerHistoryId(stepContent: string): number | null {
  const m = stepContent.match(/(?:^|\n)\s*#(\d+)\s*=\s*IFCOWNERHISTORY\b/i);
  return m ? parseInt(m[1], 10) : null;
}

/** Trigger a browser file download */
function triggerDownload(content: string | Uint8Array, filename: string, mimeType: string): void {
  if (typeof document === 'undefined') {
    throw new Error('download() requires a browser environment (document is unavailable)');
  }
  const blob = new Blob([toBlobPart(content)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
