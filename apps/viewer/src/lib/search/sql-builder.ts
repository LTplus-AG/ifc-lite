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

// ── Unified FilterRule → SQL emitter ──────────────────────────────────────────
//
// Consumes the discriminated-union shape from `filter-rules.ts`. Same SQL
// schema as the visual builder above (entities / properties / quantities)
// so the two emitters interoperate — a query produced here runs in the
// same DuckDB session a Tier-3 SQL run would use.

import type {
  FilterRule,
  Combinator,
  StoreyRule,
  IfcTypeRule,
  PredefinedTypeRule,
  NameRule,
  PropertyRule,
  QuantityRule,
  StringOp,
  NumericOp,
  ValueOp,
} from './filter-rules.js';

export interface FilterRulesSqlOptions {
  /** Default 500. `0` or negative = no LIMIT. */
  limit?: number;
  /** Default 'AND'. Top-level boolean glue between rules. */
  combinator?: Combinator;
}

/**
 * Compile a unified `FilterRule[]` to DuckDB SQL.
 *
 * Strategy: every rule contributes one boolean expression to the WHERE
 * clause. Pset/Qto rules use `EXISTS (subquery)` rather than JOINs so
 * AND/OR semantics stay obvious — JOIN-based encoding silently breaks
 * OR (a pset row that doesn't exist would just exclude the entity from
 * the join product). The subquery form mirrors the IsNotSet template
 * and degrades cleanly to "no match" when the property is absent.
 */
export function generateSqlFromFilterRules(
  rules: readonly FilterRule[],
  options: FilterRulesSqlOptions = {},
): string {
  const limit = options.limit ?? 500;
  const combinator = options.combinator ?? 'AND';

  if (rules.length === 0) return '';

  const lines: string[] = [];
  lines.push('-- Generated from unified filter rules.');
  lines.push('SELECT e.express_id, e.global_id, e.name, e.type');
  lines.push('FROM entities e');

  const predicates = rules.map(renderRulePredicate).filter((p) => p.length > 0);
  if (predicates.length > 0) {
    lines.push('WHERE');
    const glue = combinator === 'AND' ? '\n  AND ' : '\n  OR ';
    // Wrap each predicate in parens so OR doesn't bind looser than the
    // pset comparisons inside.
    lines.push('  ' + predicates.map((p) => `(${p})`).join(glue));
  }

  lines.push('ORDER BY e.name');
  if (limit > 0) lines.push(`LIMIT ${Math.max(1, Math.floor(limit))}`);
  return lines.join('\n') + ';';
}

function renderRulePredicate(rule: FilterRule): string {
  switch (rule.kind) {
    case 'storey':         return renderStoreyRule(rule);
    case 'ifcType':        return renderIfcTypeRule(rule);
    case 'predefinedType': return renderPredefinedTypeRule(rule);
    case 'name':           return renderNameRule(rule);
    case 'property':       return renderPropertyRule(rule);
    case 'quantity':       return renderQuantityRule(rule);
  }
}

function renderInList(values: readonly string[]): string {
  if (values.length === 0) return "''";
  return values.map((v) => `'${escapeSqlString(v)}'`).join(', ');
}

function renderStoreyRule(rule: StoreyRule): string {
  if (rule.values.length === 0) return rule.op === 'in' ? 'FALSE' : 'TRUE';
  // The `entities` view doesn't carry storey directly — we join through
  // relationships.contained_in_storey if the schema exposes it. The
  // default DuckDBIntegration schema doesn't, so we rely on a
  // `entity_storeys(entity_id, storey_name)` view; emit the predicate
  // and let the integration layer surface a friendly error if the view
  // is missing. (The viewer's path-B evaluator covers the common case
  // without ever needing this SQL.)
  const op = rule.op === 'in' ? 'IN' : 'NOT IN';
  return `e.express_id ${op} (
    SELECT entity_id FROM entity_storeys
    WHERE storey_name IN (${renderInList(rule.values)})
  )`;
}

function renderIfcTypeRule(rule: IfcTypeRule): string {
  if (rule.values.length === 0) return rule.op === 'in' ? 'FALSE' : 'TRUE';
  const op = rule.op === 'in' ? 'IN' : 'NOT IN';
  return `e.type ${op} (${renderInList(rule.values)})`;
}

function renderPredefinedTypeRule(rule: PredefinedTypeRule): string {
  if (rule.values.length === 0) return rule.op === 'in' ? 'FALSE' : 'TRUE';
  const op = rule.op === 'in' ? 'IN' : 'NOT IN';
  // Convention: predefined_type lives on `entities.predefined_type`. If
  // the integration only materialises it on a per-type view, the caller
  // can post-process the SQL.
  return `e.predefined_type ${op} (${renderInList(rule.values)})`;
}

function renderNameRule(rule: NameRule): string {
  return `${renderStringPredicate('e.name', rule.op, rule.value)}`;
}

function renderStringPredicate(column: string, op: StringOp, value: string): string {
  const v = escapeSqlString(value);
  switch (op) {
    case 'eq':          return `LOWER(${column}) = LOWER('${v}')`;
    case 'ne':          return `LOWER(${column}) <> LOWER('${v}')`;
    case 'contains':    return `LOWER(${column}) LIKE '%${escapeSqlString(escapeLikePattern(value).toLowerCase())}%' ESCAPE '\\'`;
    case 'notContains': return `LOWER(${column}) NOT LIKE '%${escapeSqlString(escapeLikePattern(value).toLowerCase())}%' ESCAPE '\\'`;
    case 'startsWith':  return `LOWER(${column}) LIKE '${escapeSqlString(escapeLikePattern(value).toLowerCase())}%' ESCAPE '\\'`;
  }
}

function renderPropertyRule(rule: PropertyRule): string {
  const set = escapeSqlString(rule.setName);
  const prop = escapeSqlString(rule.propertyName);
  const presence =
    `EXISTS (SELECT 1 FROM properties p
       WHERE p.entity_id = e.express_id
         AND LOWER(p.pset_name) = LOWER('${set}')
         AND LOWER(p.prop_name) = LOWER('${prop}'))`;

  if (rule.op === 'isSet')    return presence;
  if (rule.op === 'isNotSet') return `NOT ${presence}`;

  // For value comparisons, the property may have been stored in any of
  // the typed columns (value_string / value_real / value_int / value_bool).
  // We coerce to text via COALESCE-as-string for string ops, and to real
  // for numeric ops — DuckDB silently casts, NULLs drop out as no-match.
  const valueExpr = `COALESCE(p.value_string, CAST(p.value_real AS VARCHAR), CAST(p.value_int AS VARCHAR), CAST(p.value_bool AS VARCHAR))`;
  const numericExpr = `COALESCE(p.value_real, CAST(p.value_int AS DOUBLE))`;

  // After the isSet/isNotSet early-returns above, `op` is narrowed to the
  // value-comparison subset.
  const op = rule.op;
  let pred: string;
  switch (op) {
    case 'eq':
      pred = `LOWER(${valueExpr}) = LOWER('${escapeSqlString(rule.value)}')`;
      break;
    case 'ne':
      pred = `LOWER(${valueExpr}) <> LOWER('${escapeSqlString(rule.value)}')`;
      break;
    case 'contains':
      pred = `LOWER(${valueExpr}) LIKE '%${escapeSqlString(escapeLikePattern(rule.value).toLowerCase())}%' ESCAPE '\\'`;
      break;
    case 'notContains':
      pred = `LOWER(${valueExpr}) NOT LIKE '%${escapeSqlString(escapeLikePattern(rule.value).toLowerCase())}%' ESCAPE '\\'`;
      break;
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const n = Number.parseFloat(rule.value);
      const num = Number.isFinite(n) ? n : 0;
      pred = `${numericExpr} ${sqlNumericOp(op)} ${num}`;
      break;
    }
  }

  return `EXISTS (SELECT 1 FROM properties p
     WHERE p.entity_id = e.express_id
       AND LOWER(p.pset_name) = LOWER('${set}')
       AND LOWER(p.prop_name) = LOWER('${prop}')
       AND ${pred})`;
}

function renderQuantityRule(rule: QuantityRule): string {
  const set = escapeSqlString(rule.setName);
  const qty = escapeSqlString(rule.quantityName);
  return `EXISTS (SELECT 1 FROM quantities q
     WHERE q.entity_id = e.express_id
       AND LOWER(q.qset_name) = LOWER('${set}')
       AND LOWER(q.quantity_name) = LOWER('${qty}')
       AND q.value ${sqlNumericOp(rule.op)} ${rule.value})`;
}

function sqlNumericOp(op: NumericOp | Extract<ValueOp, 'gt' | 'gte' | 'lt' | 'lte'>): string {
  switch (op) {
    case 'eq':  return '=';
    case 'ne':  return '<>';
    case 'gt':  return '>';
    case 'gte': return '>=';
    case 'lt':  return '<';
    case 'lte': return '<=';
  }
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
