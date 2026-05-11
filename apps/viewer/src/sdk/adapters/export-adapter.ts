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
import { spliceScheduleIntoExport } from './export-schedule-splice.js';

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

      // Splice any in-memory schedule (parsed-and-cached, or generated
      // via the Gantt panel's "Generate from storeys" dialog) into the
      // STEP output via the shared splice helper. Keeps this adapter
      // in lockstep with the viewer's ExportDialog / ExportChangesButton
      // so bugs can't differ across surfaces.
      const exportResult = exporter.export(exportOptions);
      const spliced = spliceScheduleIntoExport(exportResult, modelId, model.ifcDataStore as IfcDataStore, {
        scheduleData: state.scheduleData ?? null,
        scheduleIsEdited: state.scheduleIsEdited === true,
        scheduleSourceModelId: state.scheduleSourceModelId ?? null,
      });
      return spliced.content;
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
  if (!scheduleData || scheduleData.tasks.length === 0) {
    // No schedule in memory. If the caller flagged "edited", the user
    // deleted every task in what used to be a parsed schedule — we
    // still want to strip the stale entities from the STEP.
    if (options?.scheduleIsEdited) {
      return stripScheduleEntities(stepContent);
    }
    return stepContent;
  }

  const hasGenerated = scheduleData.tasks.some(t => !t.expressId || t.expressId <= 0);
  const edited = options?.scheduleIsEdited === true;

  if (!edited && !hasGenerated) return stepContent;

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
    if (result.lines.length === 0) return stripped;
    return spliceBeforeEndSec(stripped, result.lines);
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
  if (result.lines.length === 0) return stepContent;
  return spliceBeforeEndSec(stepContent, result.lines);
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
  // Pass 1: collect schedule-entity IDs by tokenizing declarations.
  //
  // We walk the STEP content at the STATEMENT level (terminated by `;`
  // outside string literals), not line-by-line. Line-based splitting
  // breaks when a writer spans an entity across multiple lines —
  // valid STEP allows whitespace and newlines anywhere outside string
  // literals. Statement-based walking handles multi-line entities
  // transparently.
  const statements = tokenizeStepStatements(stepContent);
  const scheduleIds = new Set<number>();
  for (const stmt of statements) {
    if (stmt.kind !== 'entity') continue;
    if (ALWAYS_SCHEDULE_TYPES.has(stmt.typeUpper)) scheduleIds.add(stmt.id);
  }

  if (scheduleIds.size === 0) {
    // No "always" schedule entities. There can't be any schedule-related
    // relationship entities either; nothing to strip.
    return stepContent;
  }

  // Pass 2: walk statements and emit non-schedule text ranges. We keep
  // byte ranges (start/end offsets in `stepContent`) rather than
  // reassembling, so leading/trailing whitespace between statements
  // survives byte-identical when every statement is kept.
  const keptRanges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const stmt of statements) {
    if (stmt.kind !== 'entity') {
      // Non-entity text (header, section markers, whitespace) — always keep.
      continue;
    }
    if (shouldStripStatement(stmt, scheduleIds)) {
      // Push the range from `cursor` up to the statement start, then
      // advance past the statement (including trailing whitespace /
      // newline so we don't leave a gap).
      if (stmt.start > cursor) keptRanges.push({ start: cursor, end: stmt.start });
      cursor = stmt.end;
      // Also consume a trailing newline so we don't leave blank lines
      // scattered where schedule statements used to live.
      if (stepContent[cursor] === '\r') cursor++;
      if (stepContent[cursor] === '\n') cursor++;
    }
  }
  if (cursor < stepContent.length) {
    keptRanges.push({ start: cursor, end: stepContent.length });
  }

  // Concatenate kept ranges.
  if (keptRanges.length === 1 && keptRanges[0].start === 0 && keptRanges[0].end === stepContent.length) {
    return stepContent; // No-op path — nothing was stripped.
  }
  let out = '';
  for (const r of keptRanges) out += stepContent.slice(r.start, r.end);
  return out;
}

/** Per-statement classification: should we drop this record? */
function shouldStripStatement(
  stmt: { typeUpper: string; id: number; attributesText: string },
  scheduleIds: ReadonlySet<number>,
): boolean {
  if (scheduleIds.has(stmt.id)) return true; // Always-schedule entity itself.
  if (SOMETIMES_SCHEDULE_TYPES.has(stmt.typeUpper)) {
    // Relationship entity; strip only if it references a schedule id.
    return referencesAnyId(stmt.attributesText, scheduleIds);
  }
  if (stmt.typeUpper === 'IFCRELNESTS') {
    // Only strip when the referenced set includes a schedule id (the
    // nest ties a task to its children). False-positives (a nests that
    // mixes task + non-task in a single record) are vanishingly rare.
    return referencesAnyId(stmt.attributesText, scheduleIds);
  }
  return false;
}

interface StepEntityStatement {
  kind: 'entity';
  /** Byte offset of the `#` in `#ID=…`. */
  start: number;
  /** Byte offset just past the terminating `;`. */
  end: number;
  id: number;
  typeUpper: string;
  /** The parenthesised attribute list text including the outer parens. */
  attributesText: string;
}

/**
 * Tokenize `stepContent` into entity statements. Skips HEADER / DATA
 * section markers and whitespace; returns only `#ID=TYPE(…);` records.
 * Respects `'…'` string literals (STEP uses `''` to escape a quote).
 */
function tokenizeStepStatements(stepContent: string): StepEntityStatement[] {
  const out: StepEntityStatement[] = [];
  const len = stepContent.length;
  let i = 0;
  while (i < len) {
    // Skip whitespace.
    while (i < len && (stepContent[i] === ' ' || stepContent[i] === '\t' || stepContent[i] === '\n' || stepContent[i] === '\r')) i++;
    if (i >= len) break;
    // Only interested in `#N=…;` records. Anything else — header keywords,
    // section markers, end markers — gets scanned to the next `;` and
    // discarded as non-entity text.
    if (stepContent[i] !== '#') {
      // Scan to next `;` (STEP statements are `;`-terminated).
      i = scanToStatementEnd(stepContent, i);
      continue;
    }
    const declStart = i;
    i++; // past '#'
    // Read id digits.
    const idStart = i;
    while (i < len && stepContent.charCodeAt(i) >= 0x30 && stepContent.charCodeAt(i) <= 0x39) i++;
    if (i === idStart) {
      // `#` not followed by a digit — not an entity reference. Skip to `;`.
      i = scanToStatementEnd(stepContent, declStart + 1);
      continue;
    }
    const id = parseInt(stepContent.slice(idStart, i), 10);
    // Allow whitespace before `=`.
    while (i < len && (stepContent[i] === ' ' || stepContent[i] === '\t')) i++;
    if (stepContent[i] !== '=') {
      // `#N` without `=` — reference inside an attribute list; bail.
      i = scanToStatementEnd(stepContent, declStart + 1);
      continue;
    }
    i++; // past '='
    while (i < len && (stepContent[i] === ' ' || stepContent[i] === '\t')) i++;
    // Type name: uppercase letters, digits, underscore.
    const typeStart = i;
    while (i < len) {
      const c = stepContent[i];
      if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || (c >= 'a' && c <= 'z')) i++;
      else break;
    }
    if (i === typeStart) {
      i = scanToStatementEnd(stepContent, declStart + 1);
      continue;
    }
    const typeUpper = stepContent.slice(typeStart, i).toUpperCase();
    // Optional whitespace before attribute list.
    while (i < len && (stepContent[i] === ' ' || stepContent[i] === '\t' || stepContent[i] === '\n' || stepContent[i] === '\r')) i++;
    // Attribute list starts with `(`. Read until matching `)`, respecting
    // string literals and nested parens.
    const attrStart = i;
    if (stepContent[i] !== '(') {
      i = scanToStatementEnd(stepContent, declStart + 1);
      continue;
    }
    i++; // past '('
    let depth = 1;
    let inString = false;
    while (i < len && depth > 0) {
      const c = stepContent[i];
      if (inString) {
        if (c === "'") {
          // Peek for escape `''`.
          if (stepContent[i + 1] === "'") { i += 2; continue; }
          inString = false;
          i++;
          continue;
        }
        i++;
        continue;
      }
      if (c === "'") { inString = true; i++; continue; }
      if (c === '(') { depth++; i++; continue; }
      if (c === ')') { depth--; i++; continue; }
      i++;
    }
    const attrEnd = i;
    // Expect `;` terminator (optionally preceded by whitespace).
    while (i < len && (stepContent[i] === ' ' || stepContent[i] === '\t')) i++;
    if (stepContent[i] !== ';') {
      // Malformed — scan to next `;` and skip this record.
      i = scanToStatementEnd(stepContent, attrEnd);
      continue;
    }
    i++; // past ';'
    const end = i;
    out.push({
      kind: 'entity',
      start: declStart,
      end,
      id,
      typeUpper,
      attributesText: stepContent.slice(attrStart, attrEnd),
    });
  }
  return out;
}

/** Advance past the next `;` outside string literals. Never walks backwards. */
function scanToStatementEnd(s: string, from: number): number {
  const len = s.length;
  let i = from;
  let inString = false;
  while (i < len) {
    const c = s[i];
    if (inString) {
      if (c === "'") {
        if (s[i + 1] === "'") { i += 2; continue; }
        inString = false;
      }
      i++;
      continue;
    }
    if (c === "'") { inString = true; i++; continue; }
    if (c === ';') return i + 1;
    i++;
  }
  return len;
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
