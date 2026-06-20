/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bim.export — Multi-format data export
 *
 * Wraps @ifc-lite/export for GLTF, CSV, STEP, and Parquet export.
 * The export namespace works with EntityRef to determine which
 * entities to include, and delegates to the appropriate exporter.
 */

import type { BimBackend, EntityRef, EntityData, PropertySetData, QuantitySetData } from '../types.js';

export interface ExportCsvOptions {
  columns: string[];
  filename?: string;
  separator?: string;
}

export interface ExportGltfOptions {
  filename?: string;
}

export interface ExportStepOptions {
  schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3';
  filename?: string;
  includeMutations?: boolean;
  visibleOnly?: boolean;
}

export interface ExportHbjsonOptions {
  /** Honeybee model identifier / display name (defaults to the model name). */
  name?: string;
  /** When set, also trigger a download with this filename. */
  filename?: string;
}

/** bim.export — Data export in multiple formats */
export class ExportNamespace {
  constructor(private backend: BimBackend) {}

  /**
   * Export entities to CSV format.
   * Columns can be entity attributes (name, type, globalId) or
   * property paths (Pset_WallCommon.FireRating).
   */
  csv(refs: EntityRef[], options: ExportCsvOptions): string {
    const rows: string[][] = [];

    // Check if any columns need property/quantity lookups (Set.Value paths)
    const hasDotColumns = options.columns.some(c => c.indexOf('.') > 0);

    // Header row
    rows.push(options.columns);

    // Data rows
    for (const ref of refs) {
      const data = this.backend.query.entityData(ref);
      if (!data) continue;

      // Fetch properties/quantities once per entity (not per column)
      let psets: PropertySetData[] | null = null;
      let qsets: QuantitySetData[] | null = null;
      if (hasDotColumns) {
        psets = this.backend.query.properties(ref);
        qsets = this.backend.query.quantities(ref);
      }

      const row: string[] = [];
      for (const col of options.columns) {
        // IFC PascalCase attribute names (per IFC EXPRESS schema) — also accept legacy camelCase
        if (col === 'Name' || col === 'name') { row.push(data.name); continue; }
        if (col === 'Type' || col === 'type') { row.push(data.type); continue; }
        if (col === 'GlobalId' || col === 'globalId') { row.push(data.globalId); continue; }
        if (col === 'Description' || col === 'description') { row.push(data.description); continue; }
        if (col === 'ObjectType' || col === 'objectType') { row.push(data.objectType); continue; }

        // Property/Quantity path: "SetName.ValueName"
        const dotIdx = col.indexOf('.');
        if (dotIdx > 0) {
          const setName = col.slice(0, dotIdx);
          const valueName = col.slice(dotIdx + 1);

          // Try property sets first
          if (psets) {
            const pset = psets.find(p => p.name === setName);
            if (pset) {
              const prop = pset.properties.find(p => p.name === valueName);
              if (prop?.value != null) { row.push(String(prop.value)); continue; }
            }
          }

          // Fall back to quantity sets
          if (qsets) {
            const qset = qsets.find(q => q.name === setName);
            if (qset) {
              const qty = qset.quantities.find(q => q.name === valueName);
              if (qty?.value != null) { row.push(String(qty.value)); continue; }
            }
          }

          row.push('');
        } else {
          row.push('');
        }
      }
      rows.push(row);
    }

    const sep = options.separator ?? ',';
    const csvString = rows.map(r => r.map(cell => this.escapeCsv(cell, sep)).join(sep)).join('\n');

    // Trigger browser download if filename specified
    if (options.filename) {
      this.backend.export.download(csvString, options.filename, 'text/csv;charset=utf-8;');
    }

    return csvString;
  }

  /**
   * Export entities as a JSON array of objects.
   * Each object has the specified columns as keys.
   */
  json(refs: EntityRef[], columns: string[]): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    const hasDotColumns = columns.some(c => c.indexOf('.') > 0);

    for (const ref of refs) {
      const data = this.backend.query.entityData(ref);
      if (!data) continue;

      // Fetch properties/quantities once per entity (not per column)
      let psets: PropertySetData[] | null = null;
      let qsets: QuantitySetData[] | null = null;
      if (hasDotColumns) {
        psets = this.backend.query.properties(ref);
        qsets = this.backend.query.quantities(ref);
      }

      const row: Record<string, unknown> = {};
      for (const col of columns) {
        // IFC PascalCase attribute names (per IFC EXPRESS schema) — also accept legacy camelCase
        if (col === 'Name' || col === 'name') { row[col] = data.name; continue; }
        if (col === 'Type' || col === 'type') { row[col] = data.type; continue; }
        if (col === 'GlobalId' || col === 'globalId') { row[col] = data.globalId; continue; }
        if (col === 'Description' || col === 'description') { row[col] = data.description; continue; }
        if (col === 'ObjectType' || col === 'objectType') { row[col] = data.objectType; continue; }

        const dotIdx = col.indexOf('.');
        if (dotIdx > 0) {
          const setName = col.slice(0, dotIdx);
          const valueName = col.slice(dotIdx + 1);
          let resolved = false;

          // Try property sets first
          if (psets) {
            const pset = psets.find(p => p.name === setName);
            if (pset) {
              const prop = pset.properties.find(p => p.name === valueName);
              if (prop?.value != null) { row[col] = prop.value; resolved = true; }
            }
          }

          // Fall back to quantity sets
          if (!resolved && qsets) {
            const qset = qsets.find(q => q.name === setName);
            if (qset) {
              const qty = qset.quantities.find(q => q.name === valueName);
              if (qty?.value != null) { row[col] = qty.value; resolved = true; }
            }
          }

          if (!resolved) row[col] = null;
        }
      }
      result.push(row);
    }

    return result;
  }

  /**
   * Export entities to IFC STEP format.
   * Supports IFC2X3, IFC4, and IFC4X3 (IFC 4.3) schemas.
   */
  ifc(refs: EntityRef[], options: ExportStepOptions = {}): string | Uint8Array {
    const content = this.backend.export.ifc(refs, options);
    if (options.filename) {
      this.backend.export.download(content, options.filename, 'application/x-step;charset=utf-8;');
    }
    return content;
  }

  /**
   * Export the model as a Honeybee HBJSON energy/daylight model — `IfcSpace` volumes become
   * watertight rooms, windows/doors become apertures/doors, railings become shades, material
   * layer sets become opaque constructions, and shared interior walls are paired as `Surface`
   * adjacencies. Loads directly in Honeybee / Ladybug Tools / Pollination.
   *
   * Requires a geometry-capable backend (the CLI and browser carry the wasm engine); the
   * data-only SDK never meshes, so this throws on a backend that does not provide it.
   */
  async hbjson(options: ExportHbjsonOptions = {}): Promise<string> {
    if (!this.backend.export.hbjson) {
      throw new Error('HBJSON export requires a geometry-capable backend; the active backend does not provide it.');
    }
    const content = await this.backend.export.hbjson(options.name);
    if (options.filename) {
      this.backend.export.download(content, options.filename, 'application/json');
    }
    return content;
  }

  /**
   * Trigger a browser file download with raw content.
   */
  download(content: string, filename: string, mimeType?: string): void {
    this.backend.export.download(content, filename, mimeType ?? 'text/plain');
  }

  private escapeCsv(value: string, sep: string): string {
    // CSV/formula-injection guard (CWE-1236): prefix a leading spreadsheet
    // formula trigger so Excel/Sheets treat the cell as text, not a formula.
    let str = value;
    if (/^[=+\-@\t\r]/.test(str)) {
      str = `'${str}`;
    }
    if (str.includes(sep) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }
}
