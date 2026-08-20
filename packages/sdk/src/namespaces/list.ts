/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bim.list — Property lists / entity tables
 *
 * Full access to @ifc-lite/lists for configurable entity tables with
 * column discovery, filtering, presets, and CSV export.
 */

import type { ColumnDefinition, PropertyCondition } from '@ifc-lite/lists';

// ============================================================================
// Types
// ============================================================================

export interface ListColumn {
  /** Column header */
  header: string;
  /** Data source: 'name', 'type', 'globalId', or 'PsetName.PropName' */
  source: string;
}

export interface ListCondition {
  /** Property set name */
  psetName: string;
  /** Property name */
  propName: string;
  /** Comparison operator */
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'exists';
  /** Value to compare against */
  value?: string | number | boolean;
}

export interface ListDefinition {
  /** List name */
  name?: string;
  /** IFC types to include (empty = all) */
  types?: string[];
  /** Columns to display */
  columns: ListColumn[];
  /** Filter conditions */
  conditions?: ListCondition[];
  /** Maximum rows */
  limit?: number;
}

// ============================================================================
// Dynamic import
// ============================================================================

async function loadLists(): Promise<Record<string, unknown>> {
  const name = '@ifc-lite/lists';
  return import(/* webpackIgnore: true */ name) as Promise<Record<string, unknown>>;
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Translate the SDK's flat `{ header, source }` column shape into the
 * library's structured `ColumnDefinition` (`{ id, source: <enum>, psetName?,
 * propertyName, label? }`). Without this the two never lined up: the library
 * switches on `source` against its own enum ('attribute' | 'property' | ...)
 * and SDK columns carried 'name' / 'type' / 'globalId' / 'Pset.Prop' strings
 * that matched none of those cases, so `executeList` fell through to its
 * `default: values[i] = null` branch for every column, every row.
 */
function toLibraryColumn(col: ListColumn, index: number): ColumnDefinition {
  const id = `col_${index}`;
  const label = col.header;
  if (col.source === 'name') return { id, source: 'attribute', propertyName: 'Name', label };
  if (col.source === 'type') return { id, source: 'attribute', propertyName: 'Class', label };
  if (col.source === 'globalId') return { id, source: 'attribute', propertyName: 'GlobalId', label };

  const dotIdx = col.source.indexOf('.');
  if (dotIdx > 0) {
    const setName = col.source.slice(0, dotIdx);
    const propertyName = col.source.slice(dotIdx + 1);
    // Same Qto_ convention bim.bsdd uses to split property sets from
    // quantity sets: the library has no single "try property, then
    // quantity" column source, so a definitive choice is required.
    const source = setName.startsWith('Qto_') ? 'quantity' : 'property';
    return { id, source, psetName: setName, propertyName, label };
  }

  // Unrecognized shape (not one of the three special names, no dot path) —
  // pass through as a raw attribute name rather than silently dropping it.
  return { id, source: 'attribute', propertyName: col.source, label };
}

/**
 * Map the SDK's `'=' | '!=' | '>' | '<' | '>=' | '<='` operator spelling to
 * the library's `'equals' | 'notEquals' | 'gt' | 'lt' | 'gte' | 'lte'`.
 * `'contains'` and `'exists'` are spelled the same in both and pass through
 * the fallback unchanged.
 */
const CONDITION_OPERATOR_MAP: Record<string, PropertyCondition['operator']> = {
  '=': 'equals',
  '!=': 'notEquals',
  '>': 'gt',
  '<': 'lt',
  '>=': 'gte',
  '<=': 'lte',
};

/**
 * Translate the SDK's flat `{ psetName, propName, operator, value }`
 * `ListCondition` into the library's `PropertyCondition`
 * (`{ source: <enum>, psetName?, propertyName, operator, value }`).
 *
 * Without this, `execute()` passed SDK-shaped conditions straight through
 * (PR #2841 review): `PropertyCondition.source` is required and SDK
 * conditions carry none, so `getConditionValue` fell through to
 * `default: return null` for every condition, and a `null` actual value
 * makes `matchesCondition` return `false` unconditionally — every entity
 * fails every condition, so a filtered `bim.list.execute()` call silently
 * came back with an EMPTY table rather than an error or a table of nulls.
 * Same `Qto_` convention as `toLibraryColumn` and `bim.bsdd` to choose
 * between the library's `'property'` and `'quantity'` sources.
 */
function toLibraryCondition(condition: ListCondition): PropertyCondition {
  return {
    source: condition.psetName.startsWith('Qto_') ? 'quantity' : 'property',
    psetName: condition.psetName,
    propertyName: condition.propName,
    operator: CONDITION_OPERATOR_MAP[condition.operator] ?? (condition.operator as PropertyCondition['operator']),
    value: condition.value ?? '',
  };
}

// ============================================================================
// ListNamespace
// ============================================================================

/** bim.list — Entity lists, property tables, column discovery, and CSV export */
export class ListNamespace {

  // --------------------------------------------------------------------------
  // Presets
  // --------------------------------------------------------------------------

  /** Get available list presets (e.g. wall schedule, door schedule). */
  async getPresets(): Promise<unknown[]> {
    const mod = await loadLists();
    return mod.LIST_PRESETS as unknown[];
  }

  /** Get the built-in entity attribute columns (name, type, globalId, etc.). */
  async getEntityAttributes(): Promise<unknown[]> {
    const mod = await loadLists();
    return mod.ENTITY_ATTRIBUTES as unknown[];
  }

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------

  /**
   * Execute a list query against a data provider.
   *
   * ```ts
   * const result = await bim.list.execute(myProvider, {
   *   types: ['IfcWall'],
   *   columns: [
   *     { header: 'Name', source: 'name' },
   *     { header: 'Type', source: 'type' },
   *     { header: 'External', source: 'Pset_WallCommon.IsExternal' },
   *   ],
   * });
   * ```
   */
  async execute(provider: unknown, definition: ListDefinition, modelId?: string): Promise<unknown> {
    const mod = await loadLists();
    // Convert SDK's string type names to IfcTypeEnum values expected by the library
    const dataName = '@ifc-lite/data';
    const data = await import(/* webpackIgnore: true */ dataName) as Record<string, unknown>;
    const convert = data.IfcTypeEnumFromString as (s: string) => number;
    const libraryDef = {
      ...definition,
      entityTypes: (definition.types ?? []).map(t => convert(t)),
      // `conditions` is required (non-optional) on the library's
      // ListDefinition; the SDK documents it as optional, and
      // resolveSourceSet() does `conditions.length` unconditionally, so
      // omitting it threw "Cannot read properties of undefined" instead of
      // running unfiltered. Each supplied condition is also translated
      // (toLibraryCondition) — passed through raw, an SDK-shaped condition
      // matched none of the library's sources and silently emptied the
      // result instead of filtering it (PR #2841 review).
      conditions: (definition.conditions ?? []).map(toLibraryCondition),
      columns: definition.columns.map(toLibraryColumn),
    };
    return (mod.executeList as AnyFn)(libraryDef, provider, modelId ?? 'default');
  }

  // --------------------------------------------------------------------------
  // Column discovery
  // --------------------------------------------------------------------------

  /**
   * Discover available columns from a data provider.
   * Returns all property sets and their properties found in the model.
   */
  async discoverColumns(provider: unknown, entityTypes?: string[]): Promise<unknown> {
    const mod = await loadLists();
    // Convert string type names to IfcTypeEnum values expected by the library
    const dataName = '@ifc-lite/data';
    const data = await import(/* webpackIgnore: true */ dataName) as Record<string, unknown>;
    const convert = data.IfcTypeEnumFromString as (s: string) => number;
    const enumTypes = (entityTypes ?? []).map(t => convert(t));
    return (mod.discoverColumns as AnyFn)(provider, enumTypes);
  }

  // --------------------------------------------------------------------------
  // Export
  // --------------------------------------------------------------------------

  /** Convert a list result to CSV string. */
  async toCSV(result: unknown): Promise<string> {
    const mod = await loadLists();
    return (mod.listResultToCSV as (r: unknown) => string)(result);
  }
}
