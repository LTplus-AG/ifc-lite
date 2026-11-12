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

export interface JsonBounds {
  maxDepth: number;
  maxNodes: number;
}

/**
 * Walk `value` iteratively. Returns an error string when it is deeper than
 * `maxDepth` (the root is depth 1) or has more than `maxNodes` values, else null.
 */
export function checkJsonBounds(value: unknown, bounds: JsonBounds, label: string): string | null {
  const stack: Array<[unknown, number]> = [[value, 1]];
  let nodes = 0;
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (++nodes > bounds.maxNodes) return `${label} has more than ${bounds.maxNodes} values`;
    if (typeof v !== 'object' || v === null) continue;
    if (depth >= bounds.maxDepth) return `${label} is nested deeper than ${bounds.maxDepth} levels`;
    const children = Array.isArray(v) ? v : Object.values(v);
    for (const child of children) stack.push([child, depth + 1]);
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
  if (type !== undefined && typeof type !== 'string' && !(Array.isArray(type) && type.every((t) => typeof t === 'string'))) {
    return `${path}.type must be a string or an array of strings`;
  }
  if (properties !== undefined) {
    if (!isRecord(properties)) return `${path}.properties must be an object`;
    for (const [key, sub] of Object.entries(properties)) {
      const err = checkSchemaShape(sub, `${path}.properties.${key}`);
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
