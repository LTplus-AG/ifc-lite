/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Documented Claude grammar limits, checked before dispatch or budget reservation (#7132). */
import type { JsonResponseSchema } from '@ifc-lite/ai';

export function anthropicSchemaLimitation(contract: JsonResponseSchema): string | null {
  const pending: unknown[] = [contract.schema];
  const limit = 'The Anthropic response schema is too large or cyclic; simplify the field constraints';
  let unions = 0, optional = 0, scheduled = 1;
  const enqueue = (value: unknown): boolean => {
    if (++scheduled > 20_000) return false;
    pending.push(value);
    return true;
  };
  while (pending.length) {
    // Bound scheduling, including wide fan-out, rather than only work after dequeue.
    const value = pending.pop();
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const schema = value as Record<string, unknown>;
    if ((Array.isArray(schema.type) && schema.type.length > 1) || Array.isArray(schema.anyOf)) unions++;
    if (unions > 16) return 'Anthropic response schemas support at most 16 union parameters; choose fewer fields or another provider';
    if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
      const properties = schema.properties as Record<string, unknown>;
      const requiredKeys = Array.isArray(schema.required) ? schema.required : [];
      if (requiredKeys.length > 20_000) return limit;
      const required = new Set(requiredKeys);
      for (const key in properties) {
        if (!Object.hasOwn(properties, key)) continue;
        if (!required.has(key)) optional++;
        if (optional > 24) return 'Anthropic response schemas support at most 24 optional parameters; require more fields or choose another provider';
        if (!enqueue(properties[key])) return limit;
      }
    }
    for (const key of ['anyOf', 'allOf', 'oneOf']) {
      const branches = schema[key];
      if (Array.isArray(branches)) for (const branch of branches) if (!enqueue(branch)) return limit;
    }
    if (schema.items && !enqueue(schema.items)) return limit;
    for (const key of ['$defs', 'definitions']) {
      const definitions = schema[key];
      if (definitions && typeof definitions === 'object' && !Array.isArray(definitions)) {
        for (const name in definitions) {
          if (Object.hasOwn(definitions, name) && !enqueue((definitions as Record<string, unknown>)[name])) return limit;
        }
      }
    }
  }
  return null;
}
