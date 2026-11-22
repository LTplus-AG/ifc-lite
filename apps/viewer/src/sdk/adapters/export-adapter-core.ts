/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { trackExportCompleted } from '@/lib/analytics';
import { portableIfcDownload } from '../../lib/export/portable-ifc.js';
import { createStepExportMethod } from './export-adapter-step.js';
import { isEntityRefArray, normalizeRefs } from './export-entity-refs.js';
import type { StoreApi } from './types.js';
import type { EntityRef, EntityData, PropertySetData, QuantitySetData, ExportBackendMethods } from '@ifc-lite/sdk';
import { EntityNode, findPropertyInSets, findQuantityInSets } from '@ifc-lite/query';
import { escapeCsvCell } from '@ifc-lite/export';
import { getModelForRef } from './model-compat.js';
import { applyAttributeMutationsToEntityData } from './mutation-view.js';
import { downloadFile, sanitizeFilename, buildExportFilename } from '../../lib/export/download.js';
import { isFeatureEnabled } from '../../lib/features/index.js';

/** Options for CSV export */
interface CsvOptions {
  columns: string[];
  separator?: string;
  filename?: string;
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
 * RFC 4180 quoting + the CWE-1236 formula-injection guard, delegated to
 * `@ifc-lite/export`'s single escaper. The copy that used to live here tested
 * the trigger anchored at offset 0, so a BOM/ZWSP/LRM/NBSP/U+2028 in front of
 * `=` walked past it.
 */
function escapeCsv(value: string, sep: string): string {
  return escapeCsvCell(value, { delimiter: sep });
}

/**
 * Export adapter — implements CSV and JSON export directly.
 *
 * This adapter resolves entity data by dispatching to the query adapter
 * on the same LocalBackend, providing full export support for both
 * direct dispatch calls and SDK namespace usage.
 */
export function createExportAdapterWithWriter(store: StoreApi, getWriter: () => typeof import('@ifc-lite/export').StepExporter): ExportBackendMethods {
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
      const prop = findPropertyInSets(psets, setName, valueName);
      if (prop?.value != null) return String(prop.value);

      // Fall back to quantity sets
      const qsets = getQties();
      const qty = findQuantityInSets(qsets, setName, valueName);
      if (qty?.value != null) return String(qty.value);

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

    ifc: createStepExportMethod(store, getWriter),

    download(content: string | Uint8Array, filename: string, mimeType?: string) {
      triggerDownload(content, filename, mimeType ?? 'text/plain');
      return undefined;
    },
  };
}

function triggerDownload(content: string | Uint8Array, filename: string, mimeType: string): void {
  if (typeof document === 'undefined') {
    throw new Error('download() requires a browser environment (document is unavailable)');
  }
  // Scripts and extensions save files through here; a host can switch export off (`lib/features`).
  if (!isFeatureEnabled('export.files')) throw new Error('Export is switched off in this viewer');
  // Budget the stem and extension together so every SDK download gets the same safe name.
  const dot = filename.lastIndexOf('.');
  const safe = dot > 0 && dot < filename.length - 1
    ? buildExportFilename(filename.slice(0, dot), filename.slice(dot + 1))
    : sanitizeFilename(filename, { fallback: 'export' });
  const portable = portableIfcDownload(content, safe, mimeType);
  downloadFile(content, portable.filename, portable.mime);
  trackExportCompleted({ format: 'other', surface: 'script' });
}
