/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Does a stored STEP value conform to its declared EXPRESS type? Mirrors
 * `ifcopenshell.validate.assert_valid`: a typed value is only allowed where a
 * SELECT is declared, an INTEGER token is not a REAL, and entity references
 * must resolve to an instance of the declared entity.
 */

import type { Model } from '../runtime/model.js';
import type { TypeRef } from '../runtime/schema-meta.js';
import { BinaryValue, EnumValue, Ref, StepInteger, Typed, UNKNOWN, type Value } from '../runtime/values.js';

// This operates on raw STEP attributes, before references are resolved into entity objects.
function uniqueAggregate(items: Value[]): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    if (item === undefined) continue;
    const key = JSON.stringify(item, (_field, v: unknown) => {
      if (v instanceof StepInteger) return v.value;
      if (typeof v === 'symbol') return { logical: String(v) };
      return v;
    });
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export function conforms(m: Model, v: Value, type: TypeRef): boolean {
  switch (type.k) {
    case 'generic':
      return true;
    case 'simple':
      switch (type.name) {
        case 'REAL': return typeof v === 'number';
        case 'INTEGER': return v instanceof StepInteger;
        case 'NUMBER': return typeof v === 'number' || v instanceof StepInteger;
        case 'BOOLEAN': return typeof v === 'boolean';
        case 'LOGICAL': return typeof v === 'boolean' || v === UNKNOWN;
        case 'STRING': return typeof v === 'string';
        case 'BINARY': {
          if (!(v instanceof BinaryValue) || !/^(?:0|1[0-7]|2[0-3]|3[01])[0-9a-f]*$/i.test(v.hex)) return false;
          const bits = (v.hex.length - 1) * 4 - Number(v.hex[0]);
          return type.width === undefined || (type.fixed ? bits === type.width : bits <= type.width);
        }
      }
      return false;
    case 'aggregate': {
      if (!Array.isArray(v)) return false;
      if (type.kind === 'ARRAY') {
        if (type.low !== undefined && type.high !== undefined && v.length !== type.high - type.low + 1) return false;
      } else if (v.length < (type.low ?? 0) || (type.high !== undefined && v.length > type.high)) return false;
      if ((type.kind === 'SET' || type.unique) && !uniqueAggregate(v)) return false;
      return v.every((x) => (x === undefined ? type.optional : conforms(m, x, type.of)));
    }
    case 'named':
      return conformsToNamed(m, v, type.name);
  }
}

function conformsToNamed(m: Model, v: Value, name: string): boolean {
  const schema = m.schema;
  const entity = schema.entity(name);
  if (entity) {
    if (!(v instanceof Ref)) return false;
    const target = m.entityOf(v.id);
    return !!target && target.isA(entity.upper);
  }
  const t = schema.type(name);
  if (!t) return false;
  switch (t.kind) {
    case 'enum':
      return v instanceof EnumValue && t.items.includes(v.name);
    case 'defined':
      return !(v instanceof Typed) && !(v instanceof Ref) && conforms(m, v, t.underlying);
    case 'select': {
      const members = schema.selectMembers(t.name);
      if (v instanceof Ref) {
        const target = m.entityOf(v.id);
        return !!target && members.has(target.upper);
      }
      if (!(v instanceof Typed)) return false;
      const upper = v.type.toUpperCase();
      if (!members.has(upper)) return false;
      const decl = schema.type(v.type);
      if (decl?.kind === 'defined') return !(v.value instanceof Typed) && conforms(m, v.value, decl.underlying);
      if (decl?.kind === 'enum') return v.value instanceof EnumValue && decl.items.includes(v.value.name);
      return false;
    }
  }
}
