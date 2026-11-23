/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Agent-facing operation input errors. Ajv's own text ("data must have required
 * property 'scope'") names neither the operation's contract nor where to read it,
 * so the agent retries blind. This adds the failing path and a compact summary of
 * the expected input shape.
 */
import type { ErrorObject } from 'ajv';

type Schema = Record<string, unknown>;
const MAX_SUMMARY = 700;

function literal(value: unknown): string { return JSON.stringify(value) ?? String(value); }

/** One schema as a short type expression: `"a" | "b"`, `string`, `integer[]`, `object`. */
function summarize(schema: unknown, depth: number): string {
  if (!schema || typeof schema !== 'object') return 'any';
  const s = schema as Schema;
  if ('const' in s) return literal(s.const);
  if (Array.isArray(s.enum)) return s.enum.map(literal).join(' | ');
  const options = (s.anyOf ?? s.oneOf) as unknown;
  if (Array.isArray(options)) return options.map(option => summarize(option, depth)).join(' | ');
  const type = Array.isArray(s.type) ? s.type.join(' | ') : typeof s.type === 'string' ? s.type : undefined;
  if (type === 'array') return `${summarize(s.items, depth)}[]`;
  if (type === 'object' && depth > 0 && s.properties && typeof s.properties === 'object') return objectShape(s, depth - 1);
  return type ?? 'any';
}

/** `{ scope*: "current-view", limit: integer }`; `*` marks required properties. */
function objectShape(schema: Schema, depth: number): string {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
  const entries = Object.entries(properties).map(([name, property]) => `${name}${required.has(name) ? '*' : ''}: ${summarize(property, depth)}`);
  return entries.length ? `{ ${entries.join(', ')} }` : '{}';
}

export function expectedInputShape(schema: Schema): string {
  const shape = objectShape(schema, 1);
  if (shape.length <= MAX_SUMMARY) return shape;
  const flat = objectShape(schema, 0);
  return flat.length <= MAX_SUMMARY ? flat : `${flat.slice(0, MAX_SUMMARY - 1)}…`;
}

function failingPath(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  const leaf = typeof params.missingProperty === 'string' ? params.missingProperty
    : typeof params.additionalProperty === 'string' ? params.additionalProperty : undefined;
  const path = `input${error.instancePath.split('/').slice(1).map(part => (/^\d+$/.test(part) ? `[${part}]` : `.${part}`)).join('')}`;
  return leaf ? `${path}.${leaf}` : path;
}

function reason(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === 'required') return 'is required';
  if (error.keyword === 'additionalProperties') return 'is not an accepted property';
  if (error.keyword === 'const') return `must be ${literal(params.allowedValue)}`;
  if (error.keyword === 'enum' && Array.isArray(params.allowedValues)) return `must be one of ${params.allowedValues.map(literal).join(', ')}`;
  return error.message ?? 'is invalid';
}

export function operationInputError(id: string, schema: Schema, errors: readonly ErrorObject[] | null | undefined): string {
  const first = errors?.[0];
  const what = first ? `${failingPath(first)} ${reason(first)}` : 'input does not match the schema';
  return `Invalid ${id} input: ${what}. Expected input (* = required): ${expectedInputShape(schema)}. `
    + `Describe it with viewer_operations {"operation_id":"${id}"}.`;
}
