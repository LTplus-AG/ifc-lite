/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Size, depth and shape checks for tab-supplied JSON in the bridge protocol
 * (#9523). Browser-safe: no `node:*` import.
 *
 * Why: `JSON.parse` accepts a value nested ~20,000 deep, but `JSON.stringify`
 * (and any recursive walk) then throws a RangeError, and a response the stdio
 * transport cannot serialize never reaches the agent. So every tab-supplied
 * schema and result is walked here first, without recursion, and refused once
 * it is deeper or larger than the limits in `BRIDGE_LIMITS`.
 */

import { compilePattern, SUPPORTED_SCHEMA_TYPES } from '../validate.js';
import { clip } from './sanitize.js';

export interface JsonBounds {
  maxDepth: number;
  maxNodes: number;
}

/** Optional counters, for tests that pin how much work a refusal costs. */
export interface JsonBoundsStats {
  visited: number;
}

/**
 * Walk `value` iteratively. Returns an error string when it is deeper than
 * `maxDepth` (the root is depth 1) or has more than `maxNodes` values, else null.
 *
 * The budget is checked BEFORE a container's children are pushed (an array's
 * length, an object's keys counted with early exit), so an 8-million-element
 * array is refused after one visit instead of being copied onto the stack.
 * `label` must be bridge-chosen text, never tab data.
 */
export function checkJsonBounds(value: unknown, bounds: JsonBounds, label: string, stats?: JsonBoundsStats): string | null {
  const tooMany = `${label} has more than ${bounds.maxNodes} values`;
  const stack: Array<[unknown, number]> = [[value, 1]];
  let nodes = 1;
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (stats) stats.visited++;
    // JSON.parse turns 1e999 into Infinity, which re-serializes as null: refuse it.
    if (typeof v === 'number' && !Number.isFinite(v)) return `${label} contains a non-finite number`;
    if (typeof v !== 'object' || v === null) continue;
    if (depth >= bounds.maxDepth) return `${label} is nested deeper than ${bounds.maxDepth} levels`;
    const remaining = bounds.maxNodes - nodes;
    if (Array.isArray(v)) {
      if (v.length > remaining) return tooMany;
      nodes += v.length;
      for (let i = 0; i < v.length; i++) stack.push([v[i], depth + 1]);
      continue;
    }
    const record = v as Record<string, unknown>;
    let count = 0;
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      if (++count > remaining) return tooMany;
    }
    nodes += count;
    for (const key in record) {
      if (Object.prototype.hasOwnProperty.call(record, key)) stack.push([record[key], depth + 1]);
    }
  }
  return null;
}

/** UTF-8 byte length of `text`, counted without encoding it (results can be megabytes). Lone surrogates count as U+FFFD (3 bytes), as TextEncoder writes them. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const NUMERIC_KEYWORDS = ['minimum', 'exclusiveMinimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const;

/**
 * Check that every keyword the server-side validator (`validate.ts`) reads has
 * the type it expects, so a malformed schema is refused at hello/update
 * instead of throwing inside `validateInput` on the first call. Call only on
 * a value that passed {@link checkJsonBounds}, which bounds the recursion.
 */
export function checkSchemaShape(schema: unknown, path: string): string | null {
  if (!isRecord(schema)) return `${path} must be an object`;
  const { type, properties, required, items, anyOf, oneOf, additionalProperties } = schema;
  const names: unknown[] = type === undefined ? [] : Array.isArray(type) ? type : [type];
  if (!names.every((t) => typeof t === 'string' && SUPPORTED_SCHEMA_TYPES.has(t))) {
    // An unknown name (a typo like 'intrger') would be published but match every value.
    return `${path}.type must be one of ${[...SUPPORTED_SCHEMA_TYPES].join(', ')}, or an array of them`;
  }
  if (properties !== undefined) {
    if (!isRecord(properties)) return `${path}.properties must be an object`;
    for (const [key, sub] of Object.entries(properties)) {
      const err = checkSchemaShape(sub, `${path}.properties.${clip(key, 40)}`);
      if (err) return err;
    }
  }
  if (required !== undefined && !(Array.isArray(required) && required.every((r) => typeof r === 'string'))) {
    return `${path}.required must be an array of strings`;
  }
  if (items !== undefined) {
    const err = checkSchemaShape(items, `${path}.items`);
    if (err) return err;
  }
  for (const [key, branches] of [['anyOf', anyOf], ['oneOf', oneOf]] as const) {
    if (branches === undefined) continue;
    // An empty oneOf matches nothing; an empty anyOf has always been accepted as no constraint.
    if (!Array.isArray(branches) || (key === 'oneOf' && branches.length === 0)) return `${path}.${key} must be ${key === 'oneOf' ? 'a non-empty' : 'an'} array`;
    for (const [i, sub] of branches.entries()) {
      const err = checkSchemaShape(sub, `${path}.${key}[${i}]`);
      if (err) return err;
    }
  }
  // A tab schema has no `$defs` the server could resolve against; `validateInput` would throw on every call.
  if (schema.$ref !== undefined) return `${path}.$ref is not supported in a tab schema; inline the schema`;
  // validateInput runs the pattern on every call; one that does not compile would throw there instead.
  if (schema.pattern !== undefined && !compiles(schema.pattern)) return `${path}.pattern must be a valid regular expression`;
  if (additionalProperties !== undefined && typeof additionalProperties !== 'boolean') {
    const err = checkSchemaShape(additionalProperties, `${path}.additionalProperties`);
    if (err) return err;
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) return `${path}.enum must be an array`;
  for (const k of NUMERIC_KEYWORDS) {
    const v = schema[k];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) return `${path}.${k} must be a finite number`;
  }
  return null;
}

function compiles(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false;
  try {
    compilePattern(pattern);
    return true;
  } catch (err) {
    if (err instanceof SyntaxError) return false;
    throw err;
  }
}
