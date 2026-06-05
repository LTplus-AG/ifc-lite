/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CSV exporter for IFC data
 * Uses on-demand property extraction for optimal performance
 */

import {
  type IfcDataStore,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
} from '@ifc-lite/parser';
import type { PropertyValue, PropertySet, QuantitySet } from '@ifc-lite/data';

export interface CSVExportOptions {
  includeProperties?: boolean;
  includeQuantities?: boolean;
  delimiter?: string;
  flattenProperties?: boolean;
}

export class CSVExporter {
  private store: IfcDataStore;

  constructor(store: IfcDataStore) {
    this.store = store;
  }

  /**
   * Get properties for an entity, using on-demand extraction when available
   */
  private getPropertiesForEntity(entityId: number): PropertySet[] {
    // Use on-demand extraction (works with client-side WASM parsing)
    if (this.store.onDemandPropertyMap && this.store.source?.length > 0) {
      return extractPropertiesOnDemand(this.store, entityId) as PropertySet[];
    }
    // Fallback to pre-built property table (server-parsed data or cached)
    return this.store.properties?.getForEntity(entityId) ?? [];
  }

  /**
   * Get quantities for an entity, using on-demand extraction when available
   */
  private getQuantitiesForEntity(entityId: number): QuantitySet[] {
    // Use on-demand extraction (works with client-side WASM parsing)
    if (this.store.onDemandQuantityMap && this.store.source?.length > 0) {
      return extractQuantitiesOnDemand(this.store, entityId) as QuantitySet[];
    }
    // Fallback to pre-built quantity table
    return this.store.quantities?.getForEntity(entityId) ?? [];
  }

  /**
   * Export entities to CSV format
   * @param entityIds Optional array of entity IDs to export. If not provided, exports all entities.
   */
  exportEntities(entityIds?: number[], options: CSVExportOptions = {}): string {
    const delimiter = options.delimiter ?? ',';
    const includeProperties = options.includeProperties ?? false;
    const flattenProperties = options.flattenProperties ?? false;

    // Build header row with more columns
    const headers: string[] = [
      'expressId',
      'globalId',
      'name',
      'type',
      'description',
      'objectType',
      'hasGeometry',
    ];

    // Collect all unique property set names and property names (if flattening properties)
    const psetProps = new Map<string, Set<string>>();

    if (includeProperties && flattenProperties) {
      const allEntityIds = entityIds ?? this.getAllEntityIds();

      for (const id of allEntityIds) {
        const properties = this.getPropertiesForEntity(id);
        for (const pset of properties) {
          if (!psetProps.has(pset.name)) {
            psetProps.set(pset.name, new Set());
          }
          for (const prop of pset.properties) {
            psetProps.get(pset.name)!.add(prop.name);
          }
        }
      }

      // Add flattened property columns: PsetName_PropName
      for (const [psetName, propNames] of psetProps) {
        for (const propName of propNames) {
          headers.push(`${psetName}_${propName}`);
        }
      }
    }

    const rows: string[] = [this.joinRow(headers.map((h) => this.escapeValue(h)), delimiter)];

    // Get entity IDs to export
    const ids = entityIds ?? this.getAllEntityIds();

    // Build data rows
    for (const id of ids) {
      const row: string[] = [
        this.escapeValue(id),
        this.escapeValue(this.store.entities.getGlobalId(id) || ''),
        this.escapeValue(this.store.entities.getName(id) || ''),
        this.escapeValue(this.store.entities.getTypeName(id) || ''),
        this.escapeValue(this.store.entities.getDescription(id) || ''),
        this.escapeValue(this.store.entities.getObjectType(id) || ''),
        this.escapeValue(this.store.entities.hasGeometry(id) ? 'true' : 'false'),
      ];

      if (includeProperties && flattenProperties) {
        const properties = this.getPropertiesForEntity(id);
        const propMap = new Map<string, Map<string, PropertyValue>>();

        // Build map of pset -> prop -> value
        for (const pset of properties) {
          const props = new Map<string, PropertyValue>();
          for (const prop of pset.properties) {
            props.set(prop.name, prop.value);
          }
          propMap.set(pset.name, props);
        }

        // Add property values in same order as headers
        for (const [psetName, propNames] of psetProps) {
          for (const propName of propNames) {
            const value = propMap.get(psetName)?.get(propName) ?? '';
            row.push(this.escapeValue(value));
          }
        }
      }

      rows.push(this.joinRow(row, delimiter));
    }

    return rows.join('\n');
  }

  /**
   * Export properties to CSV format (one row per property)
   */
  exportProperties(entityIds?: number[], options: CSVExportOptions = {}): string {
    const delimiter = options.delimiter ?? ',';
    const headers = ['entityId', 'globalId', 'entityName', 'entityType', 'psetName', 'propName', 'value', 'type'];
    const rows: string[] = [this.joinRow(headers.map((h) => this.escapeValue(h)), delimiter)];

    const ids = entityIds ?? this.getAllEntityIds();

    for (const id of ids) {
      const properties = this.getPropertiesForEntity(id);
      if (!properties || properties.length === 0) continue;

      const globalId = this.store.entities.getGlobalId(id) || '';
      const entityName = this.store.entities.getName(id) || '';
      const entityType = this.store.entities.getTypeName(id) || '';

      for (const pset of properties) {
        if (!pset.properties || pset.properties.length === 0) continue;

        for (const prop of pset.properties) {
          const row: string[] = [
            this.escapeValue(id),
            this.escapeValue(globalId),
            this.escapeValue(entityName),
            this.escapeValue(entityType),
            this.escapeValue(pset.name || ''),
            this.escapeValue(prop.name || ''),
            this.escapeValue(prop.value),
            this.escapeValue(prop.type ?? ''),
          ];
          rows.push(this.joinRow(row, delimiter));
        }
      }
    }

    return rows.join('\n');
  }

  /**
   * Export quantities to CSV format (one row per quantity)
   */
  exportQuantities(entityIds?: number[], options: CSVExportOptions = {}): string {
    const delimiter = options.delimiter ?? ',';
    const headers = ['entityId', 'globalId', 'entityName', 'entityType', 'qsetName', 'quantityName', 'value', 'type'];
    const headerRow = this.joinRow(headers.map((h) => this.escapeValue(h)), delimiter);

    const rows: string[] = [headerRow];
    const ids = entityIds ?? this.getAllEntityIds();

    for (const id of ids) {
      const quantities = this.getQuantitiesForEntity(id);
      if (!quantities || quantities.length === 0) continue;

      const globalId = this.store.entities.getGlobalId(id) || '';
      const entityName = this.store.entities.getName(id) || '';
      const entityType = this.store.entities.getTypeName(id) || '';

      for (const qset of quantities) {
        if (!qset.quantities || qset.quantities.length === 0) continue;

        for (const quant of qset.quantities) {
          const row: string[] = [
            this.escapeValue(id),
            this.escapeValue(globalId),
            this.escapeValue(entityName),
            this.escapeValue(entityType),
            this.escapeValue(qset.name || ''),
            this.escapeValue(quant.name || ''),
            this.escapeValue(quant.value),
            this.escapeValue(quant.type ?? ''),
          ];
          rows.push(this.joinRow(row, delimiter));
        }
      }
    }

    return rows.join('\n');
  }

  /**
   * Export spatial hierarchy to CSV
   */
  exportSpatialHierarchy(options: CSVExportOptions = {}): string {
    const delimiter = options.delimiter ?? ',';
    const headers = ['expressId', 'globalId', 'name', 'type', 'parentId', 'level'];
    const rows: string[] = [this.joinRow(headers.map((h) => this.escapeValue(h)), delimiter)];

    // Get spatial hierarchy
    const spatialHierarchy = this.store.spatialHierarchy;
    if (!spatialHierarchy?.project) {
      return rows[0];
    }

    // Traverse spatial tree
    type SpatialNode = { expressId: number; name: string; children: SpatialNode[] };
    const traverse = (node: SpatialNode, parentId: number | null, level: number) => {
      const row: string[] = [
        this.escapeValue(node.expressId),
        this.escapeValue(this.store.entities.getGlobalId(node.expressId) || ''),
        this.escapeValue(node.name || ''),
        this.escapeValue(this.store.entities.getTypeName(node.expressId) || ''),
        this.escapeValue(parentId ?? ''),
        this.escapeValue(level),
      ];
      rows.push(this.joinRow(row, delimiter));

      if (node.children) {
        for (const child of node.children) {
          traverse(child, node.expressId, level + 1);
        }
      }
    };

    traverse(spatialHierarchy.project as SpatialNode, null, 0);
    return rows.join('\n');
  }

  /**
   * Get all entity IDs from the store
   */
  private getAllEntityIds(): number[] {
    const ids: number[] = [];
    const count = this.store.entities?.count ?? 0;
    for (let i = 0; i < count; i++) {
      ids.push(this.store.entities.expressId[i]);
    }
    return ids;
  }

  /**
   * Escape a value for CSV (handles quotes, commas, newlines)
   */
  private escapeValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }

    let str = String(value);

    // CSV/formula-injection guard (CWE-1236): if the value starts with a
    // spreadsheet formula trigger, prefix a single quote so Excel/Sheets
    // treat it as text. Covers = + - @ and the tab/CR control prefixes.
    if (/^[=+\-@\t\r]/.test(str)) {
      str = `'${str}`;
    }

    // If value contains delimiter, quote, or newline, wrap in quotes and escape quotes
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }

    return str;
  }

  /**
   * Join pre-escaped values into a CSV row
   * Note: Values should already be escaped before calling this
   */
  private joinRow(values: string[], delimiter: string): string {
    return values.join(delimiter);
  }
}
