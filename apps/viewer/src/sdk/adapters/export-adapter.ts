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
      // STEP is textual by spec but the underlying exporter sometimes
      // returns a Uint8Array (pre-encoded bytes). Decode → splice →
      // re-encode when that happens; the string-only short-circuit we
      // used before silently dropped the schedule on byte-path exports.
      const stepText = typeof exportedContent === 'string'
        ? exportedContent
        : new TextDecoder('utf-8', { fatal: false }).decode(exportedContent);
      const injected = injectScheduleIntoStep(
        stepText,
        state.scheduleData ?? null,
        model.ifcDataStore as IfcDataStore,
        { scheduleIsEdited: state.scheduleIsEdited === true },
      );
      return typeof exportedContent === 'string'
        ? injected
        : new TextEncoder().encode(injected);
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
 * Three cases:
 *   1. Schedule is purely parsed and untouched — leave the STEP alone.
 *   2. Schedule has generated-only tail (pre-existing behaviour) — append
 *      the generated tasks + sequences + schedules just before ENDSEC.
 *   3. Schedule has been *edited* (rename / reschedule / reassign / delete
 *      on ANY task, generated or parsed) — strip EVERY schedule entity
 *      from the STEP body and re-emit the whole `scheduleData` fresh.
 *      Dependent entities (`IfcTaskTime`, `IfcLagTime`, `IfcRel*`) cascade
 *      cleanly on deletion because we serialize the whole block at once.
 *
 * We also use the source model's existing IfcOwnerHistory (when present)
 * for the inserted entities so they share ownership metadata.
 */
export interface InjectScheduleOptions {
  /**
   * When true, the caller has edited the in-memory schedule — enter
   * rewrite mode (case 3 above). The flag is the scheduleSlice's
   * `scheduleIsEdited` value; threading it here keeps injection logic
   * free of store knowledge.
   */
  scheduleIsEdited?: boolean;
}

export function injectScheduleIntoStep(
  stepContent: string,
  scheduleData: ScheduleExtraction | null,
  ifcDataStore: IfcDataStore,
  options?: InjectScheduleOptions,
): string {
  // Breadcrumb — the re-import path has been flaky, so we log the
  // decision branch every time. If the Gantt is empty after re-import,
  // the branch taken here pinpoints whether the splice fired, was
  // skipped (and why), or emitted zero lines.
  /* eslint-disable no-console */
  const taskCount = scheduleData?.tasks.length ?? 0;
  const generatedCount = scheduleData
    ? scheduleData.tasks.filter(t => !t.expressId || t.expressId <= 0).length
    : 0;
  const wsCount = scheduleData?.workSchedules.length ?? 0;
  console.groupCollapsed(
    `%c[IfcTask] injectScheduleIntoStep — tasks=${taskCount} generated=${generatedCount} ws=${wsCount} edited=${options?.scheduleIsEdited === true}`,
    'color:#6ea2ff;font-weight:bold',
  );
  console.log('stepContent length', stepContent.length);
  console.log('has ENDSEC;', stepContent.includes('ENDSEC;'));
  console.log('options', options);
  if (scheduleData) {
    console.log('first 3 tasks', scheduleData.tasks.slice(0, 3).map(t => ({
      globalId: t.globalId, name: t.name, expressId: t.expressId,
    })));
  }
  /* eslint-enable no-console */

  const finish = (result: string, note: string): string => {
    /* eslint-disable no-console */
    console.log(note, 'out length', result.length, 'delta', result.length - stepContent.length);
    console.groupEnd();
    /* eslint-enable no-console */
    return result;
  };

  if (!scheduleData || scheduleData.tasks.length === 0) {
    // No schedule in memory. If the caller flagged "edited", the user
    // deleted every task in what used to be a parsed schedule — we
    // still want to strip the stale entities from the STEP.
    if (options?.scheduleIsEdited) {
      return finish(stripScheduleEntities(stepContent), 'branch: strip-only (edited, empty schedule)');
    }
    return finish(stepContent, 'branch: no-op (no schedule)');
  }

  const hasGenerated = scheduleData.tasks.some(t => !t.expressId || t.expressId <= 0);
  const edited = options?.scheduleIsEdited === true;

  if (!edited && !hasGenerated) {
    return finish(stepContent, 'branch: no-op (parsed unchanged)');
  }

  // Shared resolution helpers for both injection paths.
  const resolveProduct = (gid: string): number | undefined => {
    if (!gid) return undefined;
    return ifcDataStore.entities?.getExpressIdByGlobalId?.(gid) ?? undefined;
  };

  // ── Rewrite path: strip + re-emit the full schedule ─────────────
  if (edited) {
    const stripped = stripScheduleEntities(stepContent);
    const maxId = findMaxExpressId(stripped);
    const ownerHistoryId = findFirstOwnerHistoryId(stripped) ?? undefined;

    const result = serializeScheduleToStep(scheduleData, {
      nextId: maxId + 1,
      ownerHistoryId,
      resolveProductExpressId: resolveProduct,
    });
    /* eslint-disable no-console */
    console.log('rewrite: serialized', result.lines.length, 'lines; stats', result.stats);
    /* eslint-enable no-console */
    if (result.lines.length === 0) return finish(stripped, 'branch: rewrite, no lines emitted');
    return finish(spliceBeforeEndSec(stripped, result.lines), 'branch: rewrite + splice');
  }

  // ── Append-only path: only generated tasks (legacy behaviour) ───
  const generatedTasks = scheduleData.tasks.filter(t => !t.expressId || t.expressId <= 0);
  const generatedTaskGids = new Set(generatedTasks.map(t => t.globalId));
  const generatedSequences = scheduleData.sequences.filter(
    s => generatedTaskGids.has(s.relatingTaskGlobalId) && generatedTaskGids.has(s.relatedTaskGlobalId),
  );
  const generatedWorkSchedules = scheduleData.workSchedules.filter(ws => !ws.expressId || ws.expressId <= 0);

  const partitioned: ScheduleExtraction = {
    hasSchedule: true,
    workSchedules: generatedWorkSchedules,
    tasks: generatedTasks,
    sequences: generatedSequences,
  };

  const maxId = findMaxExpressId(stepContent);
  const ownerHistoryId = findFirstOwnerHistoryId(stepContent) ?? undefined;

  const result = serializeScheduleToStep(partitioned, {
    nextId: maxId + 1,
    ownerHistoryId,
    resolveProductExpressId: resolveProduct,
  });
  /* eslint-disable no-console */
  console.log('append: serialized', result.lines.length, 'lines; stats', result.stats);
  /* eslint-enable no-console */
  if (result.lines.length === 0) return finish(stepContent, 'branch: append, no lines emitted');
  return finish(spliceBeforeEndSec(stepContent, result.lines), 'branch: append + splice');
}

/**
 * Splice fresh STEP lines just before the DATA-section's closing
 * `ENDSEC;`. Anchored on the LAST `ENDSEC;` because the header section
 * also ends with one — we want the data end.
 */
function spliceBeforeEndSec(stepContent: string, lines: string[]): string {
  const endSecIdx = stepContent.lastIndexOf('ENDSEC;');
  if (endSecIdx < 0) {
    // Malformed STEP — surface the original file unchanged rather than
    // corrupting it.
    console.warn('[export] schedule injection: ENDSEC not found in STEP output');
    return stepContent;
  }
  const head = stepContent.slice(0, endSecIdx);
  const tail = stepContent.slice(endSecIdx);
  return `${head}${lines.join('\n')}\n${tail}`;
}

/**
 * Remove every schedule-related entity declaration from the STEP body.
 *
 * Two-pass:
 *   1. Identify every express ID whose entity type is in the "always a
 *      schedule entity" set (`IfcTask`, `IfcWorkSchedule`, `IfcWorkPlan`,
 *      `IfcTaskTime`, `IfcLagTime`).
 *   2. Drop lines whose ID is in that set OR whose entity type is one of
 *      the sometimes-schedule types (`IfcRelSequence`, `IfcRelAssignsTo-
 *      Process`, `IfcRelAssignsToControl`) OR `IfcRelNests` lines that
 *      reference any ID from step 1.
 *
 * The IfcRelNests check prevents us from stripping cost-item/resource
 * nests, which share the entity but aren't schedule-owned.
 */
const ALWAYS_SCHEDULE_TYPES: ReadonlySet<string> = new Set([
  'IFCTASK',
  'IFCWORKSCHEDULE',
  'IFCWORKPLAN',
  'IFCTASKTIME',
  'IFCTASKTIMERECURRING',
  'IFCLAGTIME',
]);

const SOMETIMES_SCHEDULE_TYPES: ReadonlySet<string> = new Set([
  'IFCRELSEQUENCE',
  'IFCRELASSIGNSTOPROCESS',
  'IFCRELASSIGNSTOCONTROL',
]);

function stripScheduleEntities(stepContent: string): string {
  // Pass 1: collect schedule-entity IDs.
  const scheduleIds = new Set<number>();
  // Anchored on line start + "#N = TYPE" to avoid matching refs inside
  // attribute lists. Capture group 1 is the ID, group 2 is the type.
  const declRegex = /(?:^|\n)\s*#(\d+)\s*=\s*([A-Z0-9_]+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = declRegex.exec(stepContent)) !== null) {
    const id = parseInt(m[1], 10);
    const typeUpper = m[2].toUpperCase();
    if (ALWAYS_SCHEDULE_TYPES.has(typeUpper)) scheduleIds.add(id);
  }

  if (scheduleIds.size === 0) {
    // No "always" schedule entities. There can't be any schedule-related
    // relationship entities either; nothing to strip.
    return stepContent;
  }

  // Pass 2: walk the file line-by-line, drop schedule lines.
  //
  // We preserve line endings by splitting on `\n` and re-joining. STEP
  // files use `\r\n` on some writers — `\r` ends up as a trailing char
  // on each split, which we let through unchanged on re-join.
  const lines = stepContent.split('\n');
  const out: string[] = [];
  // Per-line regex: expect `<whitespace>#ID=TYPE`. Tolerant of empty /
  // comment / section-marker lines (left intact).
  const lineDeclRegex = /^\s*#(\d+)\s*=\s*([A-Z0-9_]+)\b([\s\S]*)$/i;

  for (const raw of lines) {
    const match = lineDeclRegex.exec(raw);
    if (!match) {
      out.push(raw);
      continue;
    }
    const id = parseInt(match[1], 10);
    const typeUpper = match[2].toUpperCase();
    const rest = match[3] ?? '';

    if (scheduleIds.has(id)) continue; // Always-schedule entity itself.
    if (SOMETIMES_SCHEDULE_TYPES.has(typeUpper)) {
      // Relationship entity; keep only if we can prove it's unrelated.
      // Cheap check: does it reference a schedule-entity ID? Scan for
      // `#N` tokens and test against the set.
      if (referencesAnyId(rest, scheduleIds)) continue;
      out.push(raw);
      continue;
    }
    if (typeUpper === 'IFCRELNESTS') {
      // Only strip when the RelatingObject (first express-id arg past
      // owner history / guid / etc.) IS a task. A cheap heuristic: if
      // any referenced ID is in scheduleIds, strip. False positive for
      // a nests that mixes task + non-task would drop a non-task nest,
      // which is vanishingly rare.
      if (referencesAnyId(rest, scheduleIds)) continue;
      out.push(raw);
      continue;
    }
    out.push(raw);
  }
  return out.join('\n');
}

/** True iff any `#N` token in `rest` has N in the given set. */
function referencesAnyId(rest: string, ids: ReadonlySet<number>): boolean {
  const refRegex = /#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = refRegex.exec(rest)) !== null) {
    const n = parseInt(m[1], 10);
    if (ids.has(n)) return true;
  }
  return false;
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
