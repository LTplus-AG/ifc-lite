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
import { checkMutationGuard, type MutationGuard } from './mutation-guard.js';
import { PARSE_INVALID, parseValue } from './csv-parse-value.js';
import { buildMatchContext, matchRowAgainstContext, type CsvRow, type MatchStrategy, type MatchResult } from './csv-match.js';

// `CsvRow`, `MatchStrategy`, `MatchResult` and the indexed matching engine
// live in csv-match.ts (#5167 task 3.1) so this file stays within its
// module-size budget; re-exported here so the public import path
// (`@ifc-lite/mutations`, via index.ts) is unaffected.
export type { CsvRow, MatchStrategy, MatchResult } from './csv-match.js';

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
  /** See mutation-guard.ts: consulted once by `generateMutations`, opt-in. */
  private canEdit: MutationGuard | undefined;

  constructor(
    entities: EntityTable,
    mutationView: MutablePropertyView,
    strings?: { get(idx: number): string } | null,
    canEdit?: MutationGuard
  ) {
    this.entities = entities;
    this.mutationView = mutationView;
    this.strings = strings || null;
    this.canEdit = canEdit;
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
   * Match CSV rows to IFC entities.
   *
   * Builds the strategy's index once (see csv-match.ts) and reuses it across
   * every row — the fix for #5167 task 3.1's O(rows × entities) linear scan.
   */
  match(rows: CsvRow[], mapping: DataMapping): MatchResult[] {
    const context = buildMatchContext(this.entities, this.mutationView, this.strings, mapping.matchStrategy, rows);
    return rows.map((row, rowIndex) => matchRowAgainstContext(row, rowIndex, mapping.matchStrategy, context));
  }

  /**
   * Generate mutations from matched data.
   *
   * `warnings`, when passed, collects one message per skipped cell — a
   * malformed Real/Integer value (see {@link parseValue}) that would
   * otherwise have silently written `0`. Optional and additive: existing
   * callers that only want the mutation list are unaffected.
   */
  generateMutations(matches: MatchResult[], mapping: DataMapping, warnings?: string[]): Mutation[] {
    checkMutationGuard(this.canEdit);
    const mutations: Mutation[] = [];

    for (const match of matches) {
      if (match.matchedEntityIds.length === 0) continue;

      for (const entityId of match.matchedEntityIds) {
        for (const propMapping of mapping.propertyMappings) {
          const rawValue = match.row[propMapping.sourceColumn];
          if (rawValue === undefined || rawValue === '') continue;

          const value = propMapping.transform
            ? propMapping.transform(rawValue)
            : parseValue(rawValue, propMapping.valueType);

          if (value === PARSE_INVALID) {
            warnings?.push(
              `Row ${match.rowIndex}: could not parse "${rawValue}" in column ` +
                `"${propMapping.sourceColumn}" as ${PropertyValueType[propMapping.valueType]} ` +
                `for ${propMapping.targetPset}.${propMapping.targetProperty} — skipped`
            );
            continue;
          }

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
      const mutations = this.generateMutations(matches, mapping, stats.warnings);
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

      // Phase 2: Match in batches (0–60%). The index is built once, over the
      // full row set, before batching starts — not per batch — so batching
      // stays a progress-reporting slice, not an extra O(entities) rebuild.
      const matchContext = buildMatchContext(this.entities, this.mutationView, this.strings, mapping.matchStrategy, rows);
      const allMatches: MatchResult[] = [];
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        for (let j = 0; j < batch.length; j++) {
          const match = matchRowAgainstContext(batch[j], i + j, mapping.matchStrategy, matchContext);
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
        const mutations = this.generateMutations(batch, mapping, stats.warnings);
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
