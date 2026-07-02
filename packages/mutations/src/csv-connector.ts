/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CSV Data Connector for bulk property imports
 *
 * Allows importing property data from CSV files and mapping
 * to IFC entities.
 */

import type { EntityTable } from '@ifc-lite/data';
import { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView } from './mutable-property-view.js';
import type { Mutation, PropertyValue } from './types.js';

/**
 * A parsed CSV row
 */
export interface CsvRow {
  [column: string]: string;
}

/**
 * Match strategy for linking CSV rows to IFC entities
 */
export type MatchStrategy =
  | { type: 'globalId'; column: string }
  | { type: 'expressId'; column: string }
  | { type: 'name'; column: string }
  | { type: 'property'; psetName: string; propName: string; column: string };

/**
 * Mapping from CSV column to IFC property
 */
export interface PropertyMapping {
  /** CSV column name */
  sourceColumn: string;
  /** Target property set name */
  targetPset: string;
  /** Target property name */
  targetProperty: string;
  /** Value type */
  valueType: PropertyValueType;
  /** Optional value transformation */
  transform?: (value: string) => PropertyValue;
}

/**
 * Complete data mapping configuration
 */
export interface DataMapping {
  /** How to match CSV rows to IFC entities */
  matchStrategy: MatchStrategy;
  /** Property mappings */
  propertyMappings: PropertyMapping[];
}

/**
 * Result of matching a CSV row to entities
 */
export interface MatchResult {
  row: CsvRow;
  rowIndex: number;
  matchedEntityIds: number[];
  confidence: number; // 0-1, how confident the match is
  warnings?: string[];
}

/**
 * Statistics from CSV import
 */
export interface ImportStats {
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  mutationsCreated: number;
  errors: string[];
  warnings: string[];
}

/**
 * Progress update during async import
 */
export interface ImportProgress {
  /** Current phase of the import */
  phase: 'parsing' | 'matching' | 'applying';
  /** Unified progress 0–1 across all phases */
  percent: number;
  /** Running count of mutations created */
  mutationsCreated: number;
  /** Running count of matched rows */
  matchedRows: number;
  /** Total rows being processed */
  totalRows: number;
}

/**
 * CSV parsing options
 */
export interface CsvParseOptions {
  /** Delimiter character (default: ',') */
  delimiter?: string;
  /** Has header row (default: true) */
  hasHeader?: boolean;
  /** Skip empty rows (default: true) */
  skipEmpty?: boolean;
}

/**
 * CSV Data Connector
 */
export class CsvConnector {
  private entities: EntityTable;
  private mutationView: MutablePropertyView;
  private strings: { get(idx: number): string } | null;

  constructor(
    entities: EntityTable,
    mutationView: MutablePropertyView,
    strings?: { get(idx: number): string } | null
  ) {
    this.entities = entities;
    this.mutationView = mutationView;
    this.strings = strings || null;
  }

  /**
   * Parse CSV content into rows
   */
  parse(content: string, options: CsvParseOptions = {}): CsvRow[] {
    const delimiter = options.delimiter || ',';
    const hasHeader = options.hasHeader !== false;
    const skipEmpty = options.skipEmpty !== false;

    const lines = content.split(/\r?\n/);
    if (lines.length === 0) return [];

    // Parse header
    let headers: string[];
    let dataStartIndex: number;

    if (hasHeader) {
      headers = this.parseCsvLine(lines[0], delimiter);
      dataStartIndex = 1;
    } else {
      // Generate column names: col1, col2, etc.
      const firstLine = this.parseCsvLine(lines[0], delimiter);
      headers = firstLine.map((_, i) => `col${i + 1}`);
      dataStartIndex = 0;
    }

    // Parse data rows
    const rows: CsvRow[] = [];
    for (let i = dataStartIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (skipEmpty && !line) continue;

      const values = this.parseCsvLine(line, delimiter);
      const row: CsvRow = {};

      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = values[j] || '';
      }

      rows.push(row);
    }

    return rows;
  }

  /**
   * Match CSV rows to IFC entities
   */
  match(rows: CsvRow[], mapping: DataMapping): MatchResult[] {
    return rows.map((row, rowIndex) => this.matchRow(row, rowIndex, mapping.matchStrategy));
  }

  /**
   * Match a single row to entities
   */
  private matchRow(row: CsvRow, rowIndex: number, strategy: MatchStrategy): MatchResult {
    const matchValue = row[strategy.column];
    const matchedEntityIds: number[] = [];
    const warnings: string[] = [];

    if (!matchValue || matchValue.trim() === '') {
      warnings.push(`Empty match value in column "${strategy.column}"`);
      return { row, rowIndex, matchedEntityIds, confidence: 0, warnings };
    }

    switch (strategy.type) {
      case 'globalId':
        // Match by GlobalId
        for (let i = 0; i < this.entities.count; i++) {
          const globalIdIdx = this.entities.globalId[i];
          const globalId = this.strings?.get(globalIdIdx) || '';
          if (globalId === matchValue) {
            matchedEntityIds.push(this.entities.expressId[i]);
          }
        }
        break;

      case 'expressId':
        // Match by Express ID
        const expressId = parseInt(matchValue, 10);
        if (!isNaN(expressId)) {
          for (let i = 0; i < this.entities.count; i++) {
            if (this.entities.expressId[i] === expressId) {
              matchedEntityIds.push(expressId);
              break;
            }
          }
        } else {
          warnings.push(`Invalid Express ID: ${matchValue}`);
        }
        break;

      case 'name':
        // Match by name (case-insensitive)
        const searchName = matchValue.toLowerCase();
        for (let i = 0; i < this.entities.count; i++) {
          const nameIdx = this.entities.name[i];
          const name = (this.strings?.get(nameIdx) || '').toLowerCase();
          if (name === searchName) {
            matchedEntityIds.push(this.entities.expressId[i]);
          }
        }
        break;

      case 'property':
        // Match by existing property value
        // This would require access to the property table
        warnings.push('Property matching not yet implemented');
        break;
    }

    const confidence = matchedEntityIds.length === 1 ? 1 : matchedEntityIds.length > 1 ? 0.5 : 0;

    if (matchedEntityIds.length > 1) {
      warnings.push(`Multiple entities (${matchedEntityIds.length}) matched for value "${matchValue}"`);
    }

    return { row, rowIndex, matchedEntityIds, confidence, warnings };
  }

  /**
   * Generate mutations from matched data
   */
  generateMutations(matches: MatchResult[], mapping: DataMapping): Mutation[] {
    const mutations: Mutation[] = [];

    for (const match of matches) {
      if (match.matchedEntityIds.length === 0) continue;

      for (const entityId of match.matchedEntityIds) {
        for (const propMapping of mapping.propertyMappings) {
          const rawValue = match.row[propMapping.sourceColumn];
          if (rawValue === undefined || rawValue === '') continue;

          const value = propMapping.transform
            ? propMapping.transform(rawValue)
            : this.parseValue(rawValue, propMapping.valueType);

          const mutation = this.mutationView.setProperty(
            entityId,
            propMapping.targetPset,
            propMapping.targetProperty,
            value,
            propMapping.valueType
          );

          mutations.push(mutation);
        }
      }
    }

    return mutations;
  }

  /**
   * Import CSV data and apply to entities
   *
   * Computed name on purpose: Vite 8's dev-time import-analysis rewrites a
   * literal `import(` method head as a dynamic import (injecting
   * `__vite__injectQuery` into the parameter list), which breaks the whole
   * viewer dev server with a SyntaxError. The computed form is the same
   * public method, invisible to that rewrite.
   */
  ['import'](content: string, mapping: DataMapping, options: CsvParseOptions = {}): ImportStats {
    const stats: ImportStats = {
      totalRows: 0,
      matchedRows: 0,
      unmatchedRows: 0,
      mutationsCreated: 0,
      errors: [],
      warnings: [],
    };

    try {
      // Parse CSV
      const rows = this.parse(content, options);
      stats.totalRows = rows.length;

      // Match rows to entities
      const matches = this.match(rows, mapping);

      for (const match of matches) {
        if (match.matchedEntityIds.length > 0) {
          stats.matchedRows++;
        } else {
          stats.unmatchedRows++;
        }
        if (match.warnings) {
          stats.warnings.push(...match.warnings);
        }
      }

      // Generate and apply mutations
      const mutations = this.generateMutations(matches, mapping);
      stats.mutationsCreated = mutations.length;
    } catch (error) {
      stats.errors.push(error instanceof Error ? error.message : 'Unknown error');
    }

    return stats;
  }

  /**
   * Async batched import that yields to the main thread between batches.
   * Provides live progress updates via onProgress callback.
   */
  async importAsync(
    content: string,
    mapping: DataMapping,
    onProgress: (progress: ImportProgress) => void,
    options: CsvParseOptions & { batchSize?: number } = {}
  ): Promise<ImportStats> {
    const batchSize = options.batchSize || 200;

    const stats: ImportStats = {
      totalRows: 0,
      matchedRows: 0,
      unmatchedRows: 0,
      mutationsCreated: 0,
      errors: [],
      warnings: [],
    };

    try {
      // Unified progress: matching = 0–60%, applying = 60–100%
      const MATCH_WEIGHT = 0.6;
      const APPLY_WEIGHT = 0.4;

      // Phase 1: Parse
      onProgress({ phase: 'parsing', percent: 0, mutationsCreated: 0, matchedRows: 0, totalRows: 0 });
      const rows = this.parse(content, options);
      stats.totalRows = rows.length;

      // Phase 2: Match in batches (0–60%)
      const allMatches: MatchResult[] = [];
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        for (let j = 0; j < batch.length; j++) {
          const match = this.matchRow(batch[j], i + j, mapping.matchStrategy);
          allMatches.push(match);

          if (match.matchedEntityIds.length > 0) {
            stats.matchedRows++;
          } else {
            stats.unmatchedRows++;
          }
          if (match.warnings) {
            stats.warnings.push(...match.warnings);
          }
        }

        const matchProgress = Math.min(i + batchSize, rows.length) / rows.length;
        onProgress({
          phase: 'matching',
          percent: matchProgress * MATCH_WEIGHT,
          mutationsCreated: 0,
          matchedRows: stats.matchedRows,
          totalRows: rows.length,
        });

        // Yield to main thread
        await new Promise((r) => setTimeout(r, 0));
      }

      // Phase 3: Apply mutations in batches (60–100%)
      let mutationCount = 0;
      for (let i = 0; i < allMatches.length; i += batchSize) {
        const batch = allMatches.slice(i, i + batchSize);
        const mutations = this.generateMutations(batch, mapping);
        mutationCount += mutations.length;

        const applyProgress = Math.min(i + batchSize, allMatches.length) / allMatches.length;
        onProgress({
          phase: 'applying',
          percent: MATCH_WEIGHT + applyProgress * APPLY_WEIGHT,
          mutationsCreated: mutationCount,
          matchedRows: stats.matchedRows,
          totalRows: rows.length,
        });

        // Yield to main thread
        await new Promise((r) => setTimeout(r, 0));
      }

      stats.mutationsCreated = mutationCount;
    } catch (error) {
      stats.errors.push(error instanceof Error ? error.message : 'Unknown error');
    }

    return stats;
  }

  /**
   * Preview import without applying changes
   */
  preview(content: string, mapping: DataMapping, options: CsvParseOptions = {}): {
    rows: CsvRow[];
    matches: MatchResult[];
    estimatedMutations: number;
  } {
    const rows = this.parse(content, options);
    const matches = this.match(rows, mapping);

    let estimatedMutations = 0;
    for (const match of matches) {
      estimatedMutations += match.matchedEntityIds.length * mapping.propertyMappings.length;
    }

    return { rows, matches, estimatedMutations };
  }

  /**
   * Parse a single CSV line respecting quoted values
   */
  private parseCsvLine(line: string, delimiter: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === delimiter && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    values.push(current.trim());
    return values;
  }

  /**
   * Parse a string value to the appropriate type
   */
  private parseValue(value: string, type: PropertyValueType): PropertyValue {
    switch (type) {
      case PropertyValueType.Real:
        return parseFloat(value) || 0;

      case PropertyValueType.Integer:
        return parseInt(value, 10) || 0;

      case PropertyValueType.Boolean:
      case PropertyValueType.Logical:
        const lower = value.toLowerCase();
        return lower === 'true' || lower === 'yes' || lower === '1';

      case PropertyValueType.List:
        try {
          return JSON.parse(value);
        } catch {
          return value.split(';').map((s) => s.trim());
        }

      default:
        return value;
    }
  }

  /**
   * Auto-detect column mappings based on column names
   */
  autoDetectMappings(headers: string[]): PropertyMapping[] {
    const mappings: PropertyMapping[] = [];

    // Common property patterns
    const patterns: Array<{
      pattern: RegExp;
      pset: string;
      prop: string;
      type: PropertyValueType;
    }> = [
      { pattern: /^fire\s*rating$/i, pset: 'Pset_WallCommon', prop: 'FireRating', type: PropertyValueType.String },
      { pattern: /^load\s*bearing$/i, pset: 'Pset_WallCommon', prop: 'LoadBearing', type: PropertyValueType.Boolean },
      { pattern: /^is\s*external$/i, pset: 'Pset_WallCommon', prop: 'IsExternal', type: PropertyValueType.Boolean },
      { pattern: /^acoustic\s*rating$/i, pset: 'Pset_WallCommon', prop: 'AcousticRating', type: PropertyValueType.String },
      { pattern: /^thermal\s*transmittance$/i, pset: 'Pset_WallCommon', prop: 'ThermalTransmittance', type: PropertyValueType.Real },
      { pattern: /^manufacturer$/i, pset: 'Pset_ManufacturerTypeInformation', prop: 'Manufacturer', type: PropertyValueType.String },
      { pattern: /^model\s*reference$/i, pset: 'Pset_ManufacturerTypeInformation', prop: 'ModelReference', type: PropertyValueType.String },
      { pattern: /^article\s*number$/i, pset: 'Pset_ManufacturerTypeInformation', prop: 'ArticleNumber', type: PropertyValueType.String },
    ];

    for (const header of headers) {
      // Skip common ID columns
      if (/^(global\s*id|express\s*id|id|guid)$/i.test(header)) {
        continue;
      }

      // Check against known patterns
      let matched = false;
      for (const { pattern, pset, prop, type } of patterns) {
        if (pattern.test(header)) {
          mappings.push({
            sourceColumn: header,
            targetPset: pset,
            targetProperty: prop,
            valueType: type,
          });
          matched = true;
          break;
        }
      }

      // Default: use as custom property
      if (!matched) {
        mappings.push({
          sourceColumn: header,
          targetPset: 'Pset_Custom',
          targetProperty: this.cleanPropertyName(header),
          valueType: PropertyValueType.String,
        });
      }
    }

    return mappings;
  }

  /**
   * Clean a string to be a valid property name
   */
  private cleanPropertyName(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
  }
}
