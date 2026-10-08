/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Documented Claude grammar limits, checked before dispatch or budget reservation (#7132). */
import type { JsonResponseSchema } from '@ifc-lite/ai';

export function anthropicSchemaLimitation(contract: JsonResponseSchema): string | null {
  const pending: unknown[] = [contract.schema];
  let unions = 0, optional = 0, work = 0;
  while (pending.length) {
    // Iterative and bounded even for a malformed cyclic caller-supplied schema.
    if (++work > 20_000) return 'The Anthropic response schema is too large or cyclic; simplify the field constraints';
    const value = pending.pop();
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const schema = value as Record<string, unknown>;
    if ((Array.isArray(schema.type) && schema.type.length > 1) || Array.isArray(schema.anyOf)) unions++;
    if (unions > 16) return 'Anthropic response schemas support at most 16 union parameters; choose fewer fields or another provider';
    if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
      const properties = schema.properties as Record<string, unknown>;
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      optional += Object.keys(properties).filter(key => !required.has(key)).length;
      if (optional > 24) return 'Anthropic response schemas support at most 24 optional parameters; require more fields or choose another provider';
      pending.push(...Object.values(properties));
    }
    for (const key of ['anyOf', 'allOf', 'oneOf']) {
      const branches = schema[key];
      if (Array.isArray(branches)) pending.push(...branches);
    }
    if (schema.items) pending.push(schema.items);
    for (const key of ['$defs', 'definitions']) {
      const definitions = schema[key];
      if (definitions && typeof definitions === 'object' && !Array.isArray(definitions)) pending.push(...Object.values(definitions));
    }
  }
  return null;
}
