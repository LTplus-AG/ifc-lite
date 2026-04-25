/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SQL emitter for the unified `FilterRule[]` shape.
 *
 * Compiles chip rules from the visual builder into DuckDB SQL that runs
 * against the same schema the Editor mode queries — giving non-SQL
 * users a chip-based path to real Tier-3 queries, and a "here's what
 * your chips compile to" teaching moment when they flip to Editor.
 *
 * Hand-written string-concat is fine here because:
 *   - All identifiers (column names, table names) are compile-time
 *     constants. The emitter never aliases user input as an identifier
 *     (the previous `generateSqlFromBuilder` shape did, with an
 *     un-escaped `"${pset}.${prop}"` alias — that emitter has been
 *     removed in favour of this safer one).
 *   - All literal values pass through `escapeSqlString()` which doubles
 *     any embedded `'`. LIKE patterns additionally route through
 *     `escapeLikePattern` + `ESCAPE '\\'` so user input can't smuggle
 *     wildcards.
 */

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

/** Escape a raw string for use inside single-quoted SQL literals (DuckDB). */
export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/** Escape LIKE pattern metacharacters (so user input can't embed wildcards). */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export interface FilterRulesSqlOptions {
  /** Default 500. `0` or negative = no LIMIT. */
  limit?: number;
  /** Default 'AND'. Top-level boolean glue between rules. */
  combinator?: Combinator;
}

/**
 * Rule kinds that can't be expressed against the DuckDBIntegration schema
 * `entities` table — they fall back to Fast Run. Predefined types aren't
 * materialised as a column today; surfacing a "Fast Run only" warning in
 * the generated SQL preview is more honest than emitting a predicate
 * against a non-existent column (which would fail with a binder error
 * the moment the user clicks Run SQL).
 */
const SQL_UNSUPPORTED_RULE_KINDS: ReadonlySet<FilterRule['kind']> = new Set([
  'predefinedType',
]);

export function isSqlSupported(rule: FilterRule): boolean {
  return !SQL_UNSUPPORTED_RULE_KINDS.has(rule.kind);
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
 *
 * Rules that can't be expressed against the integration's `entities`
 * schema (currently just `predefinedType`) are silently dropped from
 * the WHERE clause and the leading comment lists how many were skipped
 * — switching to Fast Run is the supported path for those.
 */
export function generateSqlFromFilterRules(
  rules: readonly FilterRule[],
  options: FilterRulesSqlOptions = {},
): string {
  const limit = options.limit ?? 500;
  const combinator = options.combinator ?? 'AND';

  if (rules.length === 0) return '';

  const supported = rules.filter(isSqlSupported);
  const skipped = rules.length - supported.length;

  const lines: string[] = [];
  lines.push('-- Generated from unified filter rules.');
  if (skipped > 0) {
    // Listing the kinds in the comment lets the user see exactly which
    // chips dropped out — they can swap to Fast Run or remove the chip.
    const droppedKinds = rules
      .filter((r) => !isSqlSupported(r))
      .map((r) => r.kind)
      .join(', ');
    lines.push(
      `-- WARNING: ${skipped} rule(s) skipped (${droppedKinds}) — DuckDB schema doesn't expose these columns; use Fast Run instead.`,
    );
  }
  lines.push('SELECT e.express_id, e.global_id, e.name, e.type');
  lines.push('FROM entities e');

  const predicates = supported.map(renderRulePredicate).filter((p) => p.length > 0);
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
  // The DuckDBIntegration schema gives us `entities.contained_in_storey`
  // (an INTEGER pointing at the IfcBuildingStorey express_id) but no
  // dedicated `entity_storeys` view. Resolve storey names through a
  // self-lookup: the storey row IS in the same `entities` table with
  // type = 'IfcBuildingStorey'. We use ANY (subquery) rather than IN so
  // DuckDB plans this as a nested loop with the small storey side as
  // the build relation — typically <100 rows in real models.
  const op = rule.op === 'in' ? 'IN' : 'NOT IN';
  return `e.contained_in_storey ${op} (
    SELECT s.express_id FROM entities s
    WHERE s.type = 'IfcBuildingStorey'
      AND s.name IN (${renderInList(rule.values)})
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
