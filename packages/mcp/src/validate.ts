/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tiny JSON-Schema input validator (Draft 2020-12 subset).
 *
 * We only support the keywords our hand-authored tool schemas use:
 *   type, properties, required, items, enum, minimum, maximum,
 *   minLength, maxLength, default, oneOf, anyOf, additionalProperties.
 *
 * That's enough to surface clear `INVALID_INPUT` errors back to the LLM
 * without bringing in `ajv` (and its 200+ KB of metaschema) or zod.
 */

import type { JsonSchema } from './protocol/index.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  /** Input with `default` values filled in. */
  value: unknown;
}

export function validateInput(schema: JsonSchema, input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const value = walk(schema, input, '$', errors);
  return { valid: errors.length === 0, errors, value };
}

function walk(schema: JsonSchema, input: unknown, path: string, errors: ValidationIssue[]): unknown {
  if (input === undefined && schema.default !== undefined) {
    input = clone(schema.default);
  }
  if (input === undefined || input === null) return input;

  if (schema.enum && !schema.enum.includes(input as never)) {
    errors.push({ path, message: `Expected one of ${JSON.stringify(schema.enum)}; got ${JSON.stringify(input)}` });
  }

  const types = Array.isArray(schema.type) ? schema.type : (schema.type ? [schema.type] : []);
  if (types.length > 0 && !types.some((t) => matchesType(t, input))) {
    errors.push({ path, message: `Expected type ${types.join('|')}; got ${typeof input}` });
    return input;
  }

  if (matchesType('object', input) && schema.properties) {
    const obj = input as Record<string, unknown>;
    const result: Record<string, unknown> = { ...obj };
    for (const [key, sub] of Object.entries(schema.properties)) {
      const childPath = `${path}.${key}`;
      const value = walk(sub, obj[key], childPath, errors);
      if (value !== undefined) result[key] = value;
    }
    if (schema.required) {
      for (const key of schema.required) {
        if (result[key] === undefined) {
          errors.push({ path: `${path}.${key}`, message: 'Required property missing' });
        }
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          errors.push({ path: `${path}.${key}`, message: 'Unexpected property' });
        }
      }
    }
    return result;
  }

  if (matchesType('array', input) && schema.items) {
    const arr = input as unknown[];
    return arr.map((item, i) => walk(schema.items as JsonSchema, item, `${path}[${i}]`, errors));
  }

  if (typeof input === 'number') {
    if (schema.minimum !== undefined && input < schema.minimum) {
      errors.push({ path, message: `Must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && input > schema.maximum) {
      errors.push({ path, message: `Must be <= ${schema.maximum}` });
    }
  }
  if (typeof input === 'string') {
    if (schema.minLength !== undefined && input.length < schema.minLength) {
      errors.push({ path, message: `String shorter than ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && input.length > schema.maxLength) {
      errors.push({ path, message: `String longer than ${schema.maxLength}` });
    }
  }

  return input;
}

function matchesType(t: string, v: unknown): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && !Number.isNaN(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'null': return v === null;
    default: return true;
  }
}

function clone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v)) as T;
}
