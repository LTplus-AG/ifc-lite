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

import { SUPPORTED_SCHEMA_TYPES } from '../validate.js';
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

/** UTF-8 byte length of `text`. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isRecord(v: unknown): v is Record<string, unknown> {
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
  const { type, properties, required, items, anyOf, additionalProperties } = schema;
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
  if (anyOf !== undefined) {
    if (!Array.isArray(anyOf)) return `${path}.anyOf must be an array`;
    for (const [i, sub] of anyOf.entries()) {
      const err = checkSchemaShape(sub, `${path}.anyOf[${i}]`);
      if (err) return err;
    }
  }
  // `validateInput` enforces only `additionalProperties: false`; a schema there would be published but not enforced.
  if (additionalProperties !== undefined && typeof additionalProperties !== 'boolean') {
    return `${path}.additionalProperties must be true or false; a schema there is not supported`;
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) return `${path}.enum must be an array`;
  for (const k of NUMERIC_KEYWORDS) {
    const v = schema[k];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) return `${path}.${k} must be a finite number`;
  }
  return null;
}
