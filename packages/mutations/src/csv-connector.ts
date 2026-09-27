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
  /**
   * The mutations the import applied to the view, in order. A host with an
   * undo history records these (the connector writes the view directly).
   */
  mutations: Mutation[];
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
   * `warnings`, when passed, collects one message per skipped cell — one
   * that is not exactly a value of its column's type (see {@link parseValue}),
   * such as `12,5` in a Real column or `ja` in a Boolean one. Optional and additive: existing
   * callers that only want the mutation list are unaffected.
   *
   * On a throw, the writes already applied stay in the view but cannot be
   * returned; `import()` / `importAsync()` report them in `stats.mutations` (#5958).
   */
  generateMutations(matches: MatchResult[], mapping: DataMapping, warnings?: string[]): Mutation[] {
    const mutations: Mutation[] = [];
    this.applyMatches(matches, mapping, warnings, mutations);
    return mutations;
  }

  /**
   * Write `matches` to the view, pushing each mutation into `applied` the
   * moment it is written. The sink is the caller's, not a local array
   * returned at the end, so a transform or `setProperty` that throws partway
   * leaves every write that DID land in the caller's hands: the view already
   * holds them, and a host that records undo history must be able to revert
   * them (#5958).
   */
  private applyMatches(matches: MatchResult[], mapping: DataMapping, warnings: string[] | undefined, applied: Mutation[]): void {
    checkMutationGuard(this.canEdit);
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

          applied.push(this.mutationView.setProperty(
            entityId,
            propMapping.targetPset,
            propMapping.targetProperty,
            value,
            propMapping.valueType
          ));
        }
      }
    }
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
      mutations: [],
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

      // Generate and apply mutations; a throw keeps what was applied (#5958).
      this.applyMatches(matches, mapping, stats.warnings, stats.mutations);
    } catch (error) {
      stats.errors.push(error instanceof Error ? error.message : 'Unknown error');
    }
    stats.mutationsCreated = stats.mutations.length;

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
    options: CsvParseOptions & {
      batchSize?: number;
      /**
       * Called after each apply batch with the mutations it wrote, including
       * the part of a batch that landed before a throw. Lets a host record
       * undo history as the import goes, so an edit made while it yields
       * stays in commit order with it (#5958).
       */
      onApplied?: (mutations: readonly Mutation[]) => void;
    } = {}
  ): Promise<ImportStats> {
    const batchSize = options.batchSize || 200;

    const stats: ImportStats = {
      totalRows: 0,
      matchedRows: 0,
      unmatchedRows: 0,
      mutationsCreated: 0,
      mutations: [],
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
      for (let i = 0; i < allMatches.length; i += batchSize) {
        const batch = allMatches.slice(i, i + batchSize);
        const applied: Mutation[] = [];
        try {
          this.applyMatches(batch, mapping, stats.warnings, applied);
        } finally {
          // Also on a throw: these writes are in the view already (#5958).
          for (const mutation of applied) stats.mutations.push(mutation);
          if (applied.length > 0) reportApplied(options.onApplied, applied, stats.errors);
        }

        const applyProgress = Math.min(i + batchSize, allMatches.length) / allMatches.length;
        onProgress({
          phase: 'applying',
          percent: MATCH_WEIGHT + applyProgress * APPLY_WEIGHT,
          mutationsCreated: stats.mutations.length,
          matchedRows: stats.matchedRows,
          totalRows: rows.length,
        });

        // Yield to main thread
        await new Promise((r) => setTimeout(r, 0));
      }

    } catch (error) {
      stats.errors.push(error instanceof Error ? error.message : 'Unknown error');
    }
    stats.mutationsCreated = stats.mutations.length;

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

/**
 * Hand an applied batch to the host. A throwing callback is reported as an
 * import error rather than replacing the error that ended the batch (#5958).
 */
function reportApplied(
  onApplied: ((mutations: readonly Mutation[]) => void) | undefined,
  applied: readonly Mutation[],
  errors: string[],
): void {
  try {
    onApplied?.(applied);
  } catch (error) {
    errors.push(`onApplied: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
