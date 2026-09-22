/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Row-matching strategies for `CsvConnector` (#5167 task 3.1), split into a
 * sibling module so `csv-connector.ts` stays within its module-size budget
 * (see AGENTS.md's ~400-line rule; `csv-connector.ts` is already allowlisted
 * at its current size and must not grow past it).
 *
 * The index built here replaces a full linear scan of every entity FOR EVERY
 * CSV ROW (`O(rows × entities)`, ~2.5 billion comparisons for a 5k-row CSV
 * against a 500k-entity model) with one scan of the entities that builds a
 * `Map<string, number[]>` once per `import`/`preview`/`match` call, reused
 * across every row (`O(entities + rows)`).
 */

import type { EntityTable } from '@ifc-lite/data';
import { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView } from './mutable-property-view.js';
import type { PropertyValue } from './types.js';
import { PARSE_INVALID, parseValue } from './csv-parse-value.js';

/** A parsed CSV row. */
export interface CsvRow {
  [column: string]: string;
}

/** Match strategy for linking CSV rows to IFC entities. */
export type MatchStrategy =
  | { type: 'globalId'; column: string }
  | { type: 'expressId'; column: string }
  | { type: 'name'; column: string }
  /** Match on the IFC `Tag` attribute — the usual join key from a scheduling
   *  or fabrication spreadsheet (assembly/fabrication mark). */
  | { type: 'tag'; column: string }
  | { type: 'property'; psetName: string; propName: string; column: string };

/** Result of matching a CSV row to entities. */
export interface MatchResult {
  row: CsvRow;
  rowIndex: number;
  matchedEntityIds: number[];
  confidence: number; // 0-1, how confident the match is
  warnings?: string[];
}

/** Minimal string table shape `CsvConnector` is constructed with. */
type StringLookup = { get(idx: number): string } | null;

/**
 * Built once per `import`/`preview`/`match` call and reused across every
 * row. `index` maps a canonicalized match key to every entity express id
 * carrying it. `valueType` is only meaningful for the `property` strategy
 * (see {@link buildPropertyIndex}) and defaults to `String` otherwise.
 * `columnMissing` distinguishes "this CSV has no such column at all" from
 * "the cell in an existing column is blank", so the caller can warn once
 * instead of once per row.
 */
interface MatchContext {
  index: Map<string, number[]>;
  /**
   * Every distinct `PropertyValueType` the indexed property was stored under.
   * A pset property is not guaranteed to carry one type across entities, so a
   * single captured type would canonicalize an unrelated value into the same
   * key — an Integer `1` and a String `"01"` both becoming `"1"`.
   */
  valueTypes: PropertyValueType[];
  columnMissing: boolean;
}

/** Index key that keeps values of different declared types apart. */
function typedKey(type: PropertyValueType, canonical: string): string {
  return `${type}\u0000${canonical}`;
}

function addToIndex(index: Map<string, number[]>, key: string, expressId: number): void {
  const list = index.get(key);
  if (list) list.push(expressId);
  else index.set(key, [expressId]);
}

/**
 * Canonical string form of a typed property value. Used both to build the
 * `property` index (from the model's own stored values) and to key a
 * CSV cell parsed via {@link parseValue} against it, so e.g. a Boolean
 * property compares `"yes"` against `true` semantically instead of by raw
 * string identity, and a Real property compares `"60.0"` against `60`
 * numerically instead of failing a naive string `===`.
 */
function canonicalPropertyKey(value: PropertyValue, type: PropertyValueType): string {
  switch (type) {
    case PropertyValueType.Boolean:
    case PropertyValueType.Logical:
      return value ? 'true' : 'false';
    case PropertyValueType.Real:
    case PropertyValueType.Integer:
      return String(Number(value));
    case PropertyValueType.List:
      return Array.isArray(value) ? value.map((v) => String(v)).join(';') : String(value);
    default:
      return String(value);
  }
}

/**
 * Effective `Tag` attribute for an entity: a pending `UPDATE_ATTRIBUTE`
 * overlay edit wins over the base value, the same overlay-first rule every
 * other read in this package follows (`getForEntity`, `getPropertyValue`).
 * `EntityTable.getTag` is optional (server-parsed stores only, #1765); when
 * absent, only an overlay edit can supply a Tag match.
 */
function resolveTag(entities: EntityTable, mutationView: MutablePropertyView, expressId: number): string {
  for (const { name, value } of mutationView.getAttributeMutationsForEntity(expressId)) {
    if (name === 'Tag') return value;
  }
  return entities.getTag?.(expressId) ?? '';
}

function buildSimpleIndex(
  entities: EntityTable,
  mutationView: MutablePropertyView,
  strings: StringLookup,
  strategy: Extract<MatchStrategy, { type: 'globalId' | 'expressId' | 'name' | 'tag' }>
): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let i = 0; i < entities.count; i++) {
    const expressId = entities.expressId[i];
    let key: string;
    switch (strategy.type) {
      case 'globalId':
        key = strings?.get(entities.globalId[i]) || '';
        break;
      case 'expressId':
        key = String(expressId);
        break;
      case 'name':
        key = (strings?.get(entities.name[i]) || '').toLowerCase();
        break;
      case 'tag':
        key = resolveTag(entities, mutationView, expressId);
        break;
    }
    if (key) addToIndex(index, key, expressId);
  }
  return index;
}

/**
 * Index the `property` strategy over the model ONCE. `getForEntity` returns
 * property sets with pending mutations already applied — the correct read
 * path (see `MutablePropertyView.getForEntity`'s own docs) — and, critically,
 * this loop visits EVERY property set carrying `psetName`, not just the
 * first: an entity can carry a TYPE pset and an OCCURRENCE pset that share a
 * name (two distinct `IfcRelDefinesByProperties` relations). `@ifc-lite/data`
 * has no per-instance identity for same-named sets, so `psets.find(s =>
 * s.name === X)` silently sees only the first one.
 * `@ifc-lite/query`'s `findPropertyInSets`/`findAllPropertiesInSets` encode
 * this exact "scan every same-named set" contract, but `@ifc-lite/mutations`
 * does not depend on `@ifc-lite/query` (see AGENTS.md's package-dependency
 * rule) — so this is that contract's from-scratch equivalent, kept in sync
 * by intent rather than import. See `scripts/check-pset-name-find*.mjs`.
 *
 * The type used to compare a CSV cell against a stored value is read off
 * the FIRST matching property instance found (`valueType`, returned
 * alongside the index): the match strategy names a (psetName, propName)
 * pair, not a type, and a model where that pair legitimately carries
 * different declared types across entities isn't something a single CSV
 * match column can support.
 */
function buildPropertyIndex(
  entities: EntityTable,
  mutationView: MutablePropertyView,
  strategy: Extract<MatchStrategy, { type: 'property' }>
): { index: Map<string, number[]>; valueTypes: PropertyValueType[] } {
  const index = new Map<string, number[]>();
  const valueTypes = new Set<PropertyValueType>();

  for (let i = 0; i < entities.count; i++) {
    const expressId = entities.expressId[i];
    const psets = mutationView.getForEntity(expressId);
    // An entity may carry several same-named sets (a type pset and an
    // occurrence pset), which is exactly why every one of them is scanned.
    // When two of them hold the SAME value the entity would otherwise be
    // indexed twice under that key, and a single-entity match would report
    // itself as ambiguous with confidence 0.5. Duplicates ACROSS entities
    // stay — that is real ambiguity — so the guard is per entity, per key.
    const keyed = new Set<string>();
    for (const pset of psets) {
      if (pset.name !== strategy.psetName) continue;
      for (const prop of pset.properties) {
        if (prop.name !== strategy.propName) continue;
        if (prop.value === null || prop.value === undefined) continue;
        valueTypes.add(prop.type);
        // Keyed by the property's OWN declared type, never the first one seen.
        const key = typedKey(prop.type, canonicalPropertyKey(prop.value, prop.type));
        if (keyed.has(key)) continue;
        keyed.add(key);
        addToIndex(index, key, expressId);
      }
    }
  }

  return {
    index,
    valueTypes: valueTypes.size > 0 ? [...valueTypes] : [PropertyValueType.String],
  };
}

/**
 * Build the (once per call) match index plus the missing-column flag for
 * `strategy`. Only the index the given strategy actually needs is built —
 * never all five.
 */
export function buildMatchContext(
  entities: EntityTable,
  mutationView: MutablePropertyView,
  strings: StringLookup,
  strategy: MatchStrategy,
  rows: CsvRow[]
): MatchContext {
  const columnMissing =
    rows.length > 0 && !rows.some((row) => Object.prototype.hasOwnProperty.call(row, strategy.column));

  if (strategy.type === 'property') {
    const { index, valueTypes } = buildPropertyIndex(entities, mutationView, strategy);
    return { index, valueTypes, columnMissing };
  }

  return {
    index: buildSimpleIndex(entities, mutationView, strings, strategy),
    valueTypes: [PropertyValueType.String],
    columnMissing,
  };
}

/** Match one CSV row against a context built by {@link buildMatchContext}. */
export function matchRowAgainstContext(
  row: CsvRow,
  rowIndex: number,
  strategy: MatchStrategy,
  context: MatchContext
): MatchResult {
  const matchValue = row[strategy.column];
  const matchedEntityIds: number[] = [];
  const warnings: string[] = [];

  // A column absent from the CSV entirely is a file-level problem, not a
  // per-row one: warn once (on the first row only), not once per row.
  if (context.columnMissing) {
    if (rowIndex === 0) warnings.push(`Match column "${strategy.column}" not found in CSV header`);
    return { row, rowIndex, matchedEntityIds, confidence: 0, warnings };
  }

  if (!matchValue || matchValue.trim() === '') {
    warnings.push(`Empty match value in column "${strategy.column}"`);
    return { row, rowIndex, matchedEntityIds, confidence: 0, warnings };
  }

  switch (strategy.type) {
    case 'globalId':
    case 'tag': {
      const ids = context.index.get(matchValue);
      if (ids) matchedEntityIds.push(...ids);
      break;
    }

    case 'expressId': {
      const expressId = parseInt(matchValue, 10);
      if (Number.isNaN(expressId)) {
        warnings.push(`Invalid Express ID: ${matchValue}`);
      } else {
        const ids = context.index.get(String(expressId));
        if (ids) matchedEntityIds.push(...ids);
      }
      break;
    }

    case 'name': {
      const ids = context.index.get(matchValue.toLowerCase());
      if (ids) matchedEntityIds.push(...ids);
      break;
    }

    case 'property': {
      // Malformed-cell contract mirrors generateMutations: a Real/Integer
      // cell that isn't a number is SKIPPED with a warning, never coerced
      // to a fabricated match (see csv-parse-value.ts's PARSE_INVALID doc).
      // The property may be stored under several declared types across
      // entities; try each, and only report a parse failure when the cell is
      // unusable for ALL of them. An entity is collected at most once even if
      // two of its typed keys resolve to the same cell.
      const seen = new Set<number>();
      let parsedAny = false;
      for (const type of context.valueTypes) {
        const parsed = parseValue(matchValue, type);
        if (parsed === PARSE_INVALID) continue;
        parsedAny = true;
        for (const id of context.index.get(typedKey(type, canonicalPropertyKey(parsed, type))) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          matchedEntityIds.push(id);
        }
      }
      if (!parsedAny) {
        warnings.push(
          `Row ${rowIndex}: could not parse "${matchValue}" in column "${strategy.column}" as ` +
            `${context.valueTypes.map((t) => PropertyValueType[t]).join('/')} for property match ` +
            `${strategy.psetName}.${strategy.propName}`
        );
      }
      break;
    }
  }

  const confidence = matchedEntityIds.length === 1 ? 1 : matchedEntityIds.length > 1 ? 0.5 : 0;
  if (matchedEntityIds.length > 1) {
    warnings.push(`Multiple entities (${matchedEntityIds.length}) matched for value "${matchValue}"`);
  }

  return { row, rowIndex, matchedEntityIds, confidence, warnings };
}
