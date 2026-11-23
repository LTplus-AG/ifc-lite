/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcQuerySpec`: the declarative, serialisable entity query that IFC catalog
 * components carry instead of literal facts. The renderer evaluates it against
 * the loaded models, so counts and rows on screen come from the model, never
 * from text the language model typed.
 *
 * This module is pure TypeScript (no A2UI runtime) so the viewer, the sandbox
 * and the MCP server can share it. The matching zod schema lives in
 * `catalog/schemas.ts`.
 */

export const QUERY_OPERATORS = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'missing'] as const;
export type QueryOperator = (typeof QUERY_OPERATORS)[number];

export interface QueryCondition {
  /** A field path, see {@link parseFieldPath}. */
  path: string;
  op: QueryOperator;
  value?: string | number | boolean;
}

export interface IfcQuerySpec {
  /** IFC class names, case-insensitive (`IfcDoor`, `IFCWALL`). Empty or absent means every product. */
  types?: string[];
  where?: QueryCondition[];
  /** Restrict to one storey, matched against the storey Name. */
  storey?: string;
  /** Restrict to one loaded model. */
  modelId?: string;
  limit?: number;
}

export const DEFAULT_QUERY_LIMIT = 500;
export const MAX_QUERY_LIMIT = 5000;

/**
 * Field paths understood by every IFC catalog component:
 *
 * - built-ins: `name`, `globalId`, `type`, `storey`, `material`, `modelId`, `description`, `objectType`
 * - IFC attributes by their EXPRESS name, e.g. `Name`, `Tag`, `PredefinedType`
 * - property or quantity set members, `Pset_DoorCommon.FireRating`, `Qto_WallBaseQuantities.NetVolume`
 */
export type FieldPath =
  | { kind: 'builtin'; key: BuiltinField }
  | { kind: 'attribute'; name: string }
  | { kind: 'property'; set: string; name: string };

const BUILTIN_FIELDS = ['name', 'globalId', 'type', 'storey', 'material', 'modelId', 'description', 'objectType'] as const;
export type BuiltinField = (typeof BUILTIN_FIELDS)[number];

const BUILTIN_LOOKUP = new Map<string, BuiltinField>(BUILTIN_FIELDS.map((key) => [key.toLowerCase(), key]));
const ATTRIBUTE_ALIASES = new Map<string, BuiltinField>([
  ['globalid', 'globalId'],
  ['name', 'name'],
  ['description', 'description'],
  ['objecttype', 'objectType'],
]);

export function parseFieldPath(path: string): FieldPath | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const dot = trimmed.indexOf('.');
  if (dot > 0 && dot < trimmed.length - 1) {
    return { kind: 'property', set: trimmed.slice(0, dot), name: trimmed.slice(dot + 1) };
  }
  if (dot !== -1) return null;
  const lower = trimmed.toLowerCase();
  const builtin = BUILTIN_LOOKUP.get(lower) ?? ATTRIBUTE_ALIASES.get(lower);
  if (builtin) return { kind: 'builtin', key: builtin };
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(trimmed)) return null;
  return { kind: 'attribute', name: trimmed };
}

export interface QueryProblem {
  path: string;
  message: string;
}

/**
 * Clamp and validate a spec from untrusted input. Returns the normalised spec
 * and any problems; callers render problems instead of guessing.
 */
export function normalizeQuery(input: unknown): { spec: IfcQuerySpec; problems: QueryProblem[] } {
  const problems: QueryProblem[] = [];
  const spec: IfcQuerySpec = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { spec, problems: [{ path: '', message: 'query must be an object' }] };
  }
  const raw = input as Record<string, unknown>;
  if (raw.types !== undefined) {
    if (!Array.isArray(raw.types) || raw.types.some((t) => typeof t !== 'string')) {
      problems.push({ path: 'types', message: 'types must be a list of IFC class names' });
    } else {
      const types = raw.types.map((t) => (t as string).trim()).filter((t) => /^ifc[a-z0-9_]+$/i.test(t));
      if (types.length !== raw.types.length) problems.push({ path: 'types', message: 'every type must be an IFC class name such as IfcDoor' });
      if (types.length) spec.types = [...new Set(types.map((t) => t.toUpperCase()))];
    }
  }
  if (raw.where !== undefined) {
    if (!Array.isArray(raw.where)) {
      problems.push({ path: 'where', message: 'where must be a list of conditions' });
    } else {
      const where: QueryCondition[] = [];
      raw.where.forEach((c, i) => {
        const cond = c as Partial<QueryCondition> | null;
        if (!cond || typeof cond.path !== 'string' || !parseFieldPath(cond.path)) {
          problems.push({ path: `where[${i}].path`, message: 'unknown field path' });
          return;
        }
        if (!QUERY_OPERATORS.includes(cond.op as QueryOperator)) {
          problems.push({ path: `where[${i}].op`, message: `op must be one of ${QUERY_OPERATORS.join(', ')}` });
          return;
        }
        const needsValue = cond.op !== 'exists' && cond.op !== 'missing';
        const v = cond.value;
        if (needsValue && !(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
          problems.push({ path: `where[${i}].value`, message: 'value is required for this operator' });
          return;
        }
        where.push(needsValue ? { path: cond.path, op: cond.op as QueryOperator, value: v } : { path: cond.path, op: cond.op as QueryOperator });
      });
      if (where.length) spec.where = where;
    }
  }
  if (typeof raw.storey === 'string' && raw.storey.trim()) spec.storey = raw.storey.trim();
  if (typeof raw.modelId === 'string' && raw.modelId.trim()) spec.modelId = raw.modelId.trim();
  const limit = typeof raw.limit === 'number' && Number.isFinite(raw.limit) ? Math.floor(raw.limit) : DEFAULT_QUERY_LIMIT;
  spec.limit = Math.min(Math.max(limit, 1), MAX_QUERY_LIMIT);
  return { spec, problems };
}

/** Compare one field value against a condition. Strings compare case-insensitively. */
export function matchesCondition(actual: unknown, cond: QueryCondition): boolean {
  const present = actual !== undefined && actual !== null && actual !== '';
  if (cond.op === 'exists') return present;
  if (cond.op === 'missing') return !present;
  if (!present) return cond.op === 'neq';
  const expected = cond.value;
  if (cond.op === 'contains') return String(actual).toLowerCase().includes(String(expected).toLowerCase());
  if (cond.op === 'eq' || cond.op === 'neq') {
    const equal = looselyEqual(actual, expected);
    return cond.op === 'eq' ? equal : !equal;
  }
  const a = typeof actual === 'number' ? actual : Number(actual);
  const b = typeof expected === 'number' ? expected : Number(expected);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  switch (cond.op) {
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
  }
}

function looselyEqual(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'boolean') {
    if (typeof actual === 'boolean') return actual === expected;
    return String(actual).toLowerCase() === String(expected);
  }
  if (typeof expected === 'number') {
    const n = typeof actual === 'number' ? actual : Number(actual);
    return Number.isFinite(n) && n === expected;
  }
  return String(actual).toLowerCase() === String(expected).toLowerCase();
}

/** A short human description, used in captions and in follow-up prompts. */
export function describeQuery(spec: IfcQuerySpec): string {
  const types = spec.types?.length ? spec.types.join(', ') : 'all products';
  const parts = [types];
  if (spec.storey) parts.push(`on ${spec.storey}`);
  for (const c of spec.where ?? []) {
    parts.push(c.op === 'exists' || c.op === 'missing' ? `${c.path} ${c.op}` : `${c.path} ${c.op} ${String(c.value)}`);
  }
  return parts.join(' · ');
}
