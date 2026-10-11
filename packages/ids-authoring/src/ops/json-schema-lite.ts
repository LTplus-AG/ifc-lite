/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A deliberately small JSON Schema (2020-12 subset) interpreter.
 *
 * The workspace has no zod, so the op contract is authored ONCE as JSON
 * Schema (`./schema.ts`) and this interpreter validates against that very
 * object. The schema handed to an AI tool and the check the reducer relies
 * on are therefore the same data; there is nothing to drift.
 *
 * Supported keywords: `type`, `enum`, `const`, `properties`, `required`,
 * `additionalProperties` (boolean or schema), `items`, `minItems`,
 * `minLength`, `minimum`, `oneOf`, `anyOf`, `$ref` (local `#/$defs/…`),
 * `discriminator`-free unions. Anything else is ignored, so only use the
 * keywords listed here.
 */

export type JsonSchema = {
  $ref?: string;
  type?: JsonType | JsonType[];
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  oneOf?: readonly JsonSchema[];
  anyOf?: readonly JsonSchema[];
  description?: string;
  title?: string;
  pattern?: string;
};

type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

export interface SchemaError {
  path: string;
  message: string;
}

function typeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value as JsonType;
}

function typeMatches(value: unknown, type: JsonType): boolean {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate `value` against `schema`, resolving `$ref`s in `defs`. */
export function validateJson(
  value: unknown,
  schema: JsonSchema,
  defs: Record<string, JsonSchema>,
  path = '$',
): SchemaError[] {
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '');
    const target = defs[name];
    if (!target) return [{ path, message: `unknown schema reference ${schema.$ref}` }];
    return validateJson(value, target, defs, path);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      return [{ path, message: `expected ${types.join(' | ')}, got ${typeOf(value)}` }];
    }
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return [{ path, message: 'expected a finite number' }];
  }
  if (schema.const !== undefined && value !== schema.const) {
    return [{ path, message: `expected ${JSON.stringify(schema.const)}` }];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return [{ path, message: `expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` }];
  }
  const errors: SchemaError[] = [];
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push({ path, message: `must have at least ${schema.minLength} characters` });
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path, message: `must be >= ${schema.minimum}` });
  }
  if (typeof value === 'string' && schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
    errors.push({ path, message: `must match ${schema.pattern}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `must have at least ${schema.minItems} items` });
    }
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validateJson(item, schema.items as JsonSchema, defs, `${path}[${i}]`)));
    }
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value) || value[key] === undefined) errors.push({ path: `${path}.${key}`, message: 'is required' });
    }
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      const prop = schema.properties?.[key];
      if (prop) {
        errors.push(...validateJson(child, prop, defs, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, message: 'is not allowed' });
      } else if (typeof schema.additionalProperties === 'object') {
        errors.push(...validateJson(child, schema.additionalProperties, defs, `${path}.${key}`));
      }
    }
  }
  if (schema.oneOf) errors.push(...validateUnion(value, schema.oneOf, defs, path, true));
  if (schema.anyOf) errors.push(...validateUnion(value, schema.anyOf, defs, path, false));
  return errors;
}

function validateUnion(
  value: unknown,
  options: readonly JsonSchema[],
  defs: Record<string, JsonSchema>,
  path: string,
  exactlyOne: boolean,
): SchemaError[] {
  // Discriminated union (every alternative pins `kind` or `type` with a
  // `const`): validate against the alternative the discriminator selects,
  // so the error names the real problem instead of "no alternative".
  const resolved = options.map((o) => (o.$ref ? defs[o.$ref.replace('#/$defs/', '')] ?? o : o));
  for (const tag of ['kind', 'type']) {
    if (!isRecord(value) || !resolved.every((o) => o.properties?.[tag]?.const !== undefined)) continue;
    const chosen = resolved.find((o) => o.properties?.[tag]?.const === value[tag]);
    if (!chosen) {
      const allowed = resolved.map((o) => JSON.stringify(o.properties?.[tag]?.const)).join(', ');
      return [{ path: `${path}.${tag}`, message: `expected one of ${allowed}` }];
    }
    return validateJson(value, chosen, defs, path);
  }
  const results = options.map((o) => validateJson(value, o, defs, path));
  const matches = results.filter((r) => r.length === 0).length;
  if (matches === 1 || (!exactlyOne && matches > 1)) return [];
  if (matches > 1) return [{ path, message: 'matches more than one alternative' }];
  // Report the alternative that got furthest (fewest errors) — usually the
  // one the author meant, e.g. the op whose `kind` matched.
  let best = results[0];
  for (const r of results) if (r.length < best.length) best = r;
  return best;
}
