/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List execution engine - resolves source sets and extracts column values
 *
 * PERF: Uses ListDataProvider.getEntitiesByType() for O(typeRange) entity lookups,
 * and property/quantity accessors for O(1) lookups per entity.
 */

import type { PropertySet, Property, QuantitySet, Quantity } from '@ifc-lite/data';
import { parsePropertyValue } from '@ifc-lite/encoding';
import { compileNameMatcher } from './name-pattern.js';
import type {
  ListDataProvider,
  ListDefinition,
  ListResult,
  ListRow,
  ListGroup,
  ListGrouping,
  ListSummary,
  CellValue,
  PropertyCondition,
  ColumnDefinition,
} from './types.js';

/**
 * Execute a list definition against a data provider.
 * Returns a flat table result with matched entities and column values.
 */
export function executeList(
  definition: ListDefinition,
  provider: ListDataProvider,
  modelId = 'default',
): ListResult {
  const startTime = performance.now();

  // Step 1: Resolve source set (which entities match)
  const matchedIds = resolveSourceSet(definition, provider, modelId);

  // Step 2: Extract column values for matched entities. `columnMeta` collects,
  // per quantity/property column, the QuantityType / measure dataType of the
  // first matching entry seen — a side artifact of the same lookup used to
  // resolve `values[i]`, so display-unit conversion downstream (issue #1573)
  // knows what unit-KIND a raw numeric cell is in without re-deriving it.
  const rows: ListRow[] = new Array(matchedIds.length);
  const columnMeta: ColumnMeta[] = definition.columns.map(() => ({}));

  for (let i = 0; i < matchedIds.length; i++) {
    const entityId = matchedIds[i];
    const values = extractColumnValues(definition.columns, entityId, provider, columnMeta);
    rows[i] = { entityId, modelId, values };
  }

  // Step 3: Sort if configured
  if (definition.sortBy) {
    const colIndex = definition.columns.findIndex(c => c.id === definition.sortBy!.columnId);
    if (colIndex >= 0) {
      const dir = definition.sortBy.direction === 'asc' ? 1 : -1;
      rows.sort((a, b) => compareCellValues(a.values[colIndex], b.values[colIndex]) * dir);
    }
  }

  // Step 4: Group + summarise if configured
  const { groups, summary } = summariseListRows(definition, rows);

  // Merge the derived unit metadata onto the columns returned to the caller.
  // `definition.columns` (the persisted authoring schema) is left untouched —
  // only the RESULT's columns carry the execution-time annotation.
  const columns = columnMeta.some((m) => m.quantityType !== undefined || m.dataType !== undefined)
    ? definition.columns.map((c, i) => (columnMeta[i].quantityType !== undefined || columnMeta[i].dataType !== undefined)
        ? { ...c, ...columnMeta[i] }
        : c)
    : definition.columns;

  return {
    columns,
    rows,
    totalCount: rows.length,
    executionTime: performance.now() - startTime,
    groups,
    summary,
  };
}

/** Per-column derived unit metadata, keyed by column index (see `executeList`). */
interface ColumnMeta {
  quantityType?: number;
  dataType?: string;
}

// ============================================================================
// Grouping & Aggregation
// ============================================================================


/**
 * Effective ordered group-by column ids for a grouping config — `columnIds`
 * (multi-criteria, issue #1790) when present, else the legacy single
 * `columnId`. `[]` when the config only carries sum columns (or is absent).
 */
export function groupingColumnIds(grouping: ListGrouping | undefined): string[] {
  if (!grouping) return [];
  const ids = grouping.columnIds && grouping.columnIds.length > 0
    ? grouping.columnIds
    : (grouping.columnId ? [grouping.columnId] : []);
  return ids.filter(id => id !== '');
}

/**
 * Build the grouped breakdown + whole-result summary for a definition over a
 * row set. Returns `{}` when no grouping is configured, so the result shape is
 * unchanged for plain flat lists. Exported so federated callers can re-derive
 * groups/summary after merging rows from several models.
 *
 * Multi-criteria grouping (issue #1790): with several group columns the
 * returned `groups` is a FLAT pre-order list — each parent group followed by
 * its subgroups, `level`/`path` carrying the nesting. Every group carries its
 * own `count` (the Count aggregate) and per-column sums.
 */
export function summariseListRows(
  definition: ListDefinition,
  rows: ListRow[],
): { groups?: ListGroup[]; summary?: ListSummary } {
  const grouping = definition.grouping;
  if (!grouping) return {};

  const columns = definition.columns;
  // Drop group ids that no longer resolve to a column (e.g. the column was
  // removed after the grouping was persisted) so the hierarchy matches the
  // viewer/export exactly instead of inserting synthetic "(none)" levels.
  const groupIds = groupingColumnIds(grouping).filter(id => columns.some(c => c.id === id));
  // No resolvable group column (sums only, or every group column gone) keeps
  // the legacy single-bucket behaviour: every row lands in one "(none)" group.
  const levelIndices = groupIds.length > 0
    ? groupIds.map(id => columns.findIndex(c => c.id === id))
    : [-1];
  const sumIndices = grouping.sumColumnIds
    .map(id => ({ id, idx: columns.findIndex(c => c.id === id) }))
    .filter(s => s.idx >= 0);

  const zeroSums = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const s of sumIndices) out[s.id] = 0;
    return out;
  };

  // Whole-result summary (accumulated once, independent of nesting depth).
  const summary: ListSummary = { count: rows.length, sums: zeroSums() };
  for (const row of rows) {
    for (const s of sumIndices) {
      const v = row.values[s.idx];
      if (typeof v === 'number' && Number.isFinite(v)) summary.sums[s.id] += v;
    }
  }

  // Recursive per-level bucketing, preserving first-seen order within a level,
  // then ordered largest-group-first (stable default) before flattening.
  const groups: ListGroup[] = [];
  const walk = (subRows: ListRow[], level: number, parentPath: string[]) => {
    const colIdx = levelIndices[level];
    const byKey = new Map<string, { group: ListGroup; rows: ListRow[] }>();
    for (const row of subRows) {
      const raw = colIdx >= 0 ? row.values[colIdx] : null;
      const label = raw === null || raw === undefined || raw === '' ? '(none)' : String(raw);

      let bucket = byKey.get(label);
      if (!bucket) {
        const path = [...parentPath, label];
        bucket = { group: { key: groupPathKey(path), label, count: 0, sums: zeroSums(), level, path }, rows: [] };
        byKey.set(label, bucket);
      }
      bucket.group.count++;
      bucket.rows.push(row);

      for (const s of sumIndices) {
        const v = row.values[s.idx];
        if (typeof v === 'number' && Number.isFinite(v)) bucket.group.sums[s.id] += v;
      }
    }

    const ordered = Array.from(byKey.values())
      .sort((a, b) => b.group.count - a.group.count || a.group.label.localeCompare(b.group.label));
    for (const bucket of ordered) {
      groups.push(bucket.group);
      if (level + 1 < levelIndices.length) {
        walk(bucket.rows, level + 1, bucket.group.path!);
      }
    }
  };
  walk(rows, 0, []);

  return { groups, summary };
}

/**
 * Collision-free unique key for a group path: the JSON encoding of the label
 * array. A plain label join would be ambiguous whenever a model-derived label
 * contains the join separator, silently merging distinct groups' expansion /
 * render identity downstream.
 */
export function groupPathKey(path: string[]): string {
  return JSON.stringify(path);
}

// ============================================================================
// Source Set Resolution
// ============================================================================

function resolveSourceSet(
  definition: ListDefinition,
  provider: ListDataProvider,
  modelId: string,
): number[] {
  const { entityTypes, conditions, expressIdsByModel } = definition;

  let entityIds: number[];
  if (expressIdsByModel) {
    // Explicit snapshot scope (e.g. from a filter result) — target exactly
    // the ids captured FOR THIS model. Keyed by model so a federated list
    // never picks up a foreign model's element that happens to share a
    // local express ID. Still intersect with this model for safety.
    const snapshot = expressIdsByModel[modelId] ?? [];
    entityIds = snapshot.filter((id) => provider.getEntityTypeName(id) !== '');
  } else if (entityTypes.length === 0) {
    // No class constraint — target every element in the model. Requires
    // the provider to enumerate all ids; older providers without it
    // resolve to an empty set rather than throwing.
    entityIds = provider.getAllEntityIds?.() ?? [];
  } else {
    // Collect entity IDs by type - gather arrays first, then flatten once
    const chunks: number[][] = [];
    for (const type of entityTypes) {
      const ids = provider.getEntitiesByType(type);
      if (ids.length > 0) chunks.push(ids);
    }
    entityIds = chunks.length === 1 ? chunks[0] : chunks.flat();
  }

  // Apply conditions as filters
  if (conditions.length === 0) {
    return entityIds;
  }

  return entityIds.filter(id => matchesAllConditions(id, conditions, provider));
}

function matchesAllConditions(
  entityId: number,
  conditions: PropertyCondition[],
  provider: ListDataProvider,
): boolean {
  for (const condition of conditions) {
    if (!matchesCondition(entityId, condition, provider)) {
      return false;
    }
  }
  return true;
}

function matchesCondition(
  entityId: number,
  condition: PropertyCondition,
  provider: ListDataProvider,
): boolean {
  // Material and classification are multi-valued (an element can have many
  // material layers or classification refs) so they use any/none semantics
  // rather than the scalar comparison below.
  if (condition.source === 'material' || condition.source === 'classification') {
    return matchesMultiValuedCondition(entityId, condition, provider);
  }

  const actualValue = getConditionValue(entityId, condition, provider);

  if (condition.operator === 'exists') {
    return actualValue !== null && actualValue !== undefined && actualValue !== '';
  }

  if (actualValue === null || actualValue === undefined) {
    return false;
  }

  switch (condition.operator) {
    case 'equals':
      return String(actualValue) === String(condition.value);
    case 'notEquals':
      return String(actualValue) !== String(condition.value);
    case 'contains':
      return String(actualValue).toLowerCase().includes(String(condition.value).toLowerCase());
    case 'gt':
      return Number(actualValue) > Number(condition.value);
    case 'lt':
      return Number(actualValue) < Number(condition.value);
    case 'gte':
      return Number(actualValue) >= Number(condition.value);
    case 'lte':
      return Number(actualValue) <= Number(condition.value);
    default:
      return false;
  }
}

function getConditionValue(
  entityId: number,
  condition: PropertyCondition,
  provider: ListDataProvider,
): CellValue {
  switch (condition.source) {
    case 'attribute':
      return getAttributeValue(entityId, condition.propertyName, provider);
    case 'property':
      return getPropertyValue(entityId, condition.psetName ?? '', condition.propertyName, provider);
    case 'quantity':
      return getQuantityValue(entityId, condition.psetName ?? '', condition.propertyName, provider);
    case 'spatial':
      return getSpatialValue(entityId, condition.propertyName, provider);
    case 'model':
      return provider.getModelName?.() || null;
    default:
      return null;
  }
}

/**
 * Resolve a `spatial` column/condition to a spatial-container name at the
 * requested level. `propertyName` selects the level, matched
 * CASE-INSENSITIVELY so a hand-edited / imported list with `container` resolves
 * the Container level rather than silently falling through. An empty or
 * genuinely unrecognised level still falls back to `Storey`, so level-less
 * lists authored before the level existed keep resolving the storey name.
 * `Container` is the element's IMMEDIATE container (nearest
 * IfcRelContainedInSpatialStructure parent, any level); `Project` is constant
 * per model.
 */
function getSpatialValue(
  entityId: number,
  level: string,
  provider: ListDataProvider,
): CellValue {
  switch (level.toLowerCase()) {
    case 'container':
      return provider.getContainerName?.(entityId) || null;
    case 'building':
      return provider.getBuildingName?.(entityId) || null;
    case 'site':
      return provider.getSiteName?.(entityId) || null;
    case 'project':
      return provider.getProjectName?.() || null;
    case 'storey':
    default:
      return provider.getStoreyName?.(entityId) || null;
  }
}

/**
 * Match a multi-valued condition (material / classification). Positive
 * operators match if ANY candidate value satisfies them; `notEquals`
 * matches only if NO candidate equals the value. An element with no
 * materials / classifications never matches (including `notEquals`),
 * except `exists` which is a pure presence check.
 */
function matchesMultiValuedCondition(
  entityId: number,
  condition: PropertyCondition,
  provider: ListDataProvider,
): boolean {
  const candidates = condition.source === 'material'
    ? (provider.getMaterialNames?.(entityId) ?? [])
    : classificationCandidates(provider.getClassifications?.(entityId) ?? []);

  if (condition.operator === 'exists') return candidates.length > 0;
  if (candidates.length === 0) return false;

  const target = String(condition.value).toLowerCase();
  switch (condition.operator) {
    case 'equals':
      return candidates.some(c => c.toLowerCase() === target);
    case 'contains':
      return candidates.some(c => c.toLowerCase().includes(target));
    case 'notEquals':
      return candidates.every(c => c.toLowerCase() !== target);
    default:
      // gt/lt/gte/lte have no meaning for material/classification strings.
      return false;
  }
}

/** Flatten classification refs into a candidate string list (code + name). */
function classificationCandidates(
  refs: ReadonlyArray<{ code?: string; name?: string }>,
): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    if (ref.code) out.push(ref.code);
    if (ref.name) out.push(ref.name);
  }
  return out;
}

// ============================================================================
// Column Value Extraction
// ============================================================================

function extractColumnValues(
  columns: ColumnDefinition[],
  entityId: number,
  provider: ListDataProvider,
  columnMeta: ColumnMeta[],
): CellValue[] {
  // For efficiency, batch extract properties and quantities once per entity
  const needsProperties = columns.some(c => c.source === 'property');
  const needsQuantities = columns.some(c => c.source === 'quantity');

  let psets: PropertySet[] | undefined;
  let qsets: QuantitySet[] | undefined;

  if (needsProperties) {
    psets = provider.getPropertySets(entityId);
  }
  if (needsQuantities) {
    qsets = provider.getQuantitySets(entityId);
  }

  // Type-inherited sets are fetched lazily — only when an instance-level lookup
  // misses — so the common case (property lives on the instance) never pays for
  // resolving the element's IfcTypeProduct. Cached per entity across columns.
  let typePsets: PropertySet[] | undefined;
  let typeQsets: QuantitySet[] | undefined;
  const getTypePsets = (): PropertySet[] => {
    if (typePsets === undefined) typePsets = provider.getTypePropertySets?.(entityId) ?? [];
    return typePsets;
  };
  const getTypeQsets = (): QuantitySet[] => {
    if (typeQsets === undefined) typeQsets = provider.getTypeQuantitySets?.(entityId) ?? [];
    return typeQsets;
  };

  const values: CellValue[] = new Array(columns.length);
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    switch (col.source) {
      case 'attribute':
        values[i] = getAttributeValue(entityId, col.propertyName, provider);
        break;
      case 'property': {
        // Automatic Type fallback (issue #1745): instance psets win; only when
        // the instance has no matching property do we consult the type's.
        let prop = findPropertyEntry(psets ?? [], col.psetName ?? '', col.propertyName);
        if (!prop) prop = findPropertyEntry(getTypePsets(), col.psetName ?? '', col.propertyName);
        values[i] = prop ? resolvePropertyValue(prop.value) : null;
        if (prop?.dataType && columnMeta[i].dataType === undefined) columnMeta[i].dataType = prop.dataType;
        break;
      }
      case 'quantity': {
        let quant = findQuantityEntry(qsets ?? [], col.psetName ?? '', col.propertyName);
        if (!quant) quant = findQuantityEntry(getTypeQsets(), col.psetName ?? '', col.propertyName);
        values[i] = quant ? formatQuantityValue(quant.value, quant.type) : null;
        if (quant && columnMeta[i].quantityType === undefined) columnMeta[i].quantityType = quant.type;
        break;
      }
      case 'material': {
        const names = provider.getMaterialNames?.(entityId) ?? [];
        values[i] = names.length > 0 ? uniqueJoin(names) : null;
        break;
      }
      case 'classification': {
        const refs = provider.getClassifications?.(entityId) ?? [];
        const codes = refs.map(r => r.code || r.name || '').filter(s => s.length > 0);
        values[i] = codes.length > 0 ? uniqueJoin(codes) : null;
        break;
      }
      case 'spatial':
        values[i] = getSpatialValue(entityId, col.propertyName, provider);
        break;
      case 'model':
        values[i] = provider.getModelName?.() || null;
        break;
      default:
        values[i] = null;
    }
  }
  return values;
}

/** Join a list of strings into a single cell value, de-duplicated and
 *  order-preserving (an element can repeat a material across layers). */
function uniqueJoin(values: string[]): string {
  return Array.from(new Set(values)).join(', ');
}

// ============================================================================
// Value Accessors
// ============================================================================

function getAttributeValue(entityId: number, attrName: string, provider: ListDataProvider): CellValue {
  switch (attrName) {
    case 'Name':
      return provider.getEntityName(entityId) || null;
    case 'GlobalId':
      return provider.getEntityGlobalId(entityId) || null;
    case 'Class':
      return provider.getEntityTypeName(entityId) || null;
    case 'Type':
      // The element's IfcTypeProduct name (issue #1754).
      return provider.getEntityDefiningTypeName?.(entityId) || null;
    case 'Description':
      return provider.getEntityDescription(entityId) || null;
    case 'ObjectType':
      return provider.getEntityObjectType(entityId) || null;
    case 'PredefinedType':
      return provider.getEntityPredefinedType?.(entityId) || null;
    case 'Tag':
      return provider.getEntityTag(entityId) || null;
    default:
      return null;
  }
}

function getPropertyValue(
  entityId: number,
  psetName: string,
  propName: string,
  provider: ListDataProvider,
): CellValue {
  const prop = findPropertyEntry(provider.getPropertySets(entityId), psetName, propName)
    // Type fallback (issue #1745) so conditions filter on type-inherited values too.
    ?? findPropertyEntry(provider.getTypePropertySets?.(entityId) ?? [], psetName, propName);
  return prop ? resolvePropertyValue(prop.value) : null;
}

function getQuantityValue(
  entityId: number,
  qsetName: string,
  quantName: string,
  provider: ListDataProvider,
): CellValue {
  const quant = findQuantityEntry(provider.getQuantitySets(entityId), qsetName, quantName)
    ?? findQuantityEntry(provider.getTypeQuantitySets?.(entityId) ?? [], qsetName, quantName);
  return quant ? formatQuantityValue(quant.value, quant.type) : null;
}

/** Find the raw matching property entry (name + value + dataType), so
 *  callers that need the measure `dataType` (issue #1573) don't have to
 *  re-walk the sets. */
function findPropertyEntry(psets: PropertySet[], psetName: string, propName: string): Property | undefined {
  // Set and property names support Bonsai-style `/regex/` patterns, so one
  // column can pull a value from several psets at once (issue #1591); a plain
  // name stays an exact match.
  const matchSet = compileNameMatcher(psetName);
  const matchProp = compileNameMatcher(propName);
  for (const pset of psets) {
    if (matchSet(pset.name)) {
      for (const prop of pset.properties) {
        if (matchProp(prop.name)) return prop;
      }
    }
  }
  return undefined;
}

/**
 * Resolve a raw IFC property value to a clean display value.
 * Handles typed arrays [IFCTYPE, value], boolean enums (.T./.F./.U.),
 * IFC string encodings, etc.
 */
function resolvePropertyValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;

  const parsed = parsePropertyValue(value);
  const display = parsed.displayValue;

  // Return null for em-dash (null indicator)
  if (display === '\u2014') return null;

  // Try to preserve numeric values for sorting
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return display; // "True"/"False"

  // For typed values like [IFCREAL, 5.3], check if the resolved value is numeric
  if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'number') {
    return value[1];
  }

  return display;
}

/** Find the raw matching quantity entry (name + value + type), so callers
 *  that need the `QuantityType` (issue #1573) don't have to re-walk the
 *  sets. */
function findQuantityEntry(qsets: QuantitySet[], qsetName: string, quantName: string): Quantity | undefined {
  // Qset and quantity names support `/regex/` patterns too (see findPropertyEntry).
  const matchSet = compileNameMatcher(qsetName);
  const matchQuant = compileNameMatcher(quantName);
  for (const qset of qsets) {
    if (matchSet(qset.name)) {
      for (const quant of qset.quantities) {
        if (matchQuant(quant.name)) return quant;
      }
    }
  }
  return undefined;
}

function formatQuantityValue(value: number, _type: number): CellValue {
  // Return raw number to preserve numeric sorting.
  // Display formatting (locale, units) is handled by the UI layer.
  return value;
}

// ============================================================================
// Sorting
// ============================================================================

function compareCellValues(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;

  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }

  return String(a).localeCompare(String(b));
}

// ============================================================================
// CSV Export from List Result
// ============================================================================

export function listResultToCSV(result: ListResult, delimiter = ','): string {
  const csvEscape = (val: CellValue): string => {
    if (val === null || val === undefined) return '';
    let str = String(val);
    // CSV/formula-injection guard (CWE-1236): prefix a leading spreadsheet
    // formula trigger so Excel/Sheets treat the cell as text, not a formula.
    // A genuine numeric cell is exempt — the old guard also matched a leading
    // `-`/`+`, so `-0.35` exported as `'-0.35` and broke Excel SUM(). A cell that
    // is a plain (optionally signed, decimal/exponent) number carries no formula
    // payload, so it is left untouched; anything else with a trigger prefix
    // (including `-cmd` or `-1+cmd`) is still quoted.
    if (/^[=+\-@\t\r]/.test(str) && !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(str)) {
      str = `'${str}`;
    }
    if (str.includes(delimiter) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headers = result.columns.map(c => csvEscape(c.label ?? `${c.psetName ? c.psetName + '.' : ''}${c.propertyName}`));
  const lines = [headers.join(delimiter)];

  for (const row of result.rows) {
    lines.push(row.values.map(csvEscape).join(delimiter));
  }

  return lines.join('\n');
}
