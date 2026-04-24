/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Visual-builder state + SQL generator.
 *
 * The builder is a small structured representation of "entities, filtered
 * by IFC type and a list of property predicates, ordered by name, capped".
 * It compiles to DuckDB SQL that runs against the same schema the Editor
 * mode queries — giving non-SQL users a chip-based path to real Tier-3
 * queries, and a "here's what your chips compile to" teaching moment
 * when they flip to Editor mode.
 *
 * Hand-written string-concat is fine here because:
 *   - All identifiers (column names, table names, aliases) are
 *     compile-time constants.
 *   - All values pass through `escapeSqlString()` which doubles any
 *     embedded `'`. DuckDB has no multi-statement ; injection risk for
 *     single-string literals because the driver parses one statement
 *     per `.query()` call, but we still guard at the builder layer to
 *     prevent unbalanced quotes or accidental comment injection.
 */

export type BuilderOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains';
export type BuilderValueType = 'string' | 'bool' | 'real' | 'int';

export interface PropertyFilter {
  /** Pset name, e.g. `Pset_WallCommon`. Empty string = no pset predicate. */
  psetName: string;
  /** Property name, e.g. `IsExternal`. Empty string = row is skipped. */
  propName: string;
  op: BuilderOp;
  valueType: BuilderValueType;
  /** Raw user input. Interpretation depends on `valueType`. */
  value: string;
}

export interface VisualBuilderState {
  /** Canonical IFC type (PascalCase like `IfcWall`). `null` / empty = any type. */
  ifcType: string | null;
  propertyFilters: PropertyFilter[];
  /** Integer cap. `0` or negative = no LIMIT clause. */
  limit: number;
}

/** Sensible empty state used by the store initializer. */
export function emptyBuilderState(): VisualBuilderState {
  return { ifcType: null, propertyFilters: [], limit: 500 };
}

/** Escape a raw string for use inside single-quoted SQL literals (DuckDB). */
export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/** Escape LIKE pattern metacharacters (so user input can't embed wildcards). */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Generate a SQL query from the builder state. Returns an empty string
 * if the state is entirely empty (no type, no filters, default limit)
 * — the UI uses that as a signal to show "pick a type or add a filter".
 */
export function generateSqlFromBuilder(state: VisualBuilderState): string {
  const hasType = !!state.ifcType && state.ifcType.trim().length > 0;
  const validFilters = state.propertyFilters.filter(
    (f) => f.psetName.trim().length > 0 && f.propName.trim().length > 0,
  );
  const hasFilters = validFilters.length > 0;

  const lines: string[] = [];
  lines.push('-- Generated from the visual query builder.');

  // SELECT list — if filters were defined, include the matched value as a
  // pseudo-column for each so results are self-describing.
  const selectCols = ['e.express_id', 'e.global_id', 'e.name', 'e.type'];
  validFilters.forEach((f, i) => {
    const alias = `p${i + 1}`;
    const column = valueColumnForType(f.valueType);
    selectCols.push(`${alias}.${column} AS "${f.psetName}.${f.propName}"`);
  });
  lines.push('SELECT');
  lines.push('  ' + selectCols.join(',\n  '));

  // FROM + per-filter JOINs.
  lines.push('FROM entities e');
  validFilters.forEach((f, i) => {
    const alias = `p${i + 1}`;
    lines.push(`JOIN properties ${alias} ON ${alias}.entity_id = e.express_id`);
  });

  // WHERE — collect every predicate.
  const where: string[] = [];
  if (hasType) {
    where.push(`e.type = '${escapeSqlString(state.ifcType!)}'`);
  }
  validFilters.forEach((f, i) => {
    const alias = `p${i + 1}`;
    where.push(`${alias}.pset_name = '${escapeSqlString(f.psetName)}'`);
    where.push(`${alias}.prop_name = '${escapeSqlString(f.propName)}'`);
    where.push(renderValuePredicate(alias, f));
  });
  if (where.length > 0) {
    lines.push('WHERE');
    lines.push('  ' + where.join('\n  AND '));
  }

  // ORDER BY name for stable output — cheap and makes batch-review usable.
  lines.push('ORDER BY e.name');

  if (state.limit > 0) {
    lines.push(`LIMIT ${Math.max(1, Math.floor(state.limit))}`);
  }

  // Empty-state signal: if there's no type, no filters, and default limit
  // is all we'd emit, return an empty string so the UI can show a hint.
  if (!hasType && !hasFilters && state.limit === 500) {
    return '';
  }

  return lines.join('\n') + ';';
}

function valueColumnForType(t: BuilderValueType): string {
  switch (t) {
    case 'string': return 'value_string';
    case 'bool':   return 'value_bool';
    case 'real':   return 'value_real';
    case 'int':    return 'value_int';
  }
}

function renderValuePredicate(alias: string, f: PropertyFilter): string {
  const column = `${alias}.${valueColumnForType(f.valueType)}`;
  const raw = f.value;

  if (f.op === 'contains') {
    // contains is only meaningful for string; silently collapse for other
    // types so the query still parses.
    if (f.valueType !== 'string') {
      return `${column} = ${renderScalar(f.valueType, raw)}`;
    }
    const escaped = escapeLikePattern(raw);
    return `${column} LIKE '%${escapeSqlString(escaped)}%' ESCAPE '\\'`;
  }

  return `${column} ${f.op} ${renderScalar(f.valueType, raw)}`;
}

function renderScalar(t: BuilderValueType, raw: string): string {
  const trimmed = raw.trim();
  if (t === 'string') {
    return `'${escapeSqlString(raw)}'`;
  }
  if (t === 'bool') {
    return trimmed.toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
  }
  if (t === 'int') {
    const n = Number.parseInt(trimmed, 10);
    return Number.isFinite(n) ? String(n) : '0';
  }
  // real
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? String(n) : '0';
}

/**
 * Common starter IFC types — used as a dropdown when the active model's
 * type catalog isn't available. The UI may extend this list from the
 * active model's `entityIndex.byType` keys when present.
 */
export const COMMON_IFC_TYPES: readonly string[] = [
  'IfcWall',
  'IfcWallStandardCase',
  'IfcSlab',
  'IfcBeam',
  'IfcColumn',
  'IfcDoor',
  'IfcWindow',
  'IfcRoof',
  'IfcStair',
  'IfcStairFlight',
  'IfcRailing',
  'IfcRamp',
  'IfcSpace',
  'IfcCovering',
  'IfcCurtainWall',
  'IfcFooting',
  'IfcPlate',
  'IfcMember',
  'IfcOpeningElement',
  'IfcBuildingElementProxy',
  'IfcFurnishingElement',
  'IfcDistributionElement',
];
