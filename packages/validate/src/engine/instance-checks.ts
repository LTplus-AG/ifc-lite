/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Per-instance schema checks: record syntax, abstractness, attribute presence and types, INVERSE cardinality, and defined-type WHERE rules. */

import { violated } from '../runtime/logic.js';
import type { Model } from '../runtime/model.js';
import type { TypeRef } from '../runtime/schema-meta.js';
import type { ResolvedEntity } from '../runtime/schema-runtime.js';
import { DERIVED, Typed, type Value } from '../runtime/values.js';
import type { ValidationFinding } from './findings.js';
import { conforms } from './value-types.js';
import { guard } from './guard.js';

export interface InstanceCheckCounters {
  typeRuleEvaluations: number;
}

function describe(v: Value): string {
  if (v === undefined) return '$';
  if (v === DERIVED) return '*';
  if (Array.isArray(v)) return `(${v.length} items)`;
  if (typeof v === 'object' && v !== null) return v.constructor.name;
  return JSON.stringify(v);
}

function typeLabel(t: TypeRef): string {
  switch (t.k) {
    case 'simple': return t.name;
    case 'named': return t.name;
    case 'generic': return 'GENERIC';
    case 'aggregate': return `${t.kind} [${t.low}:${t.high ?? '?'}] OF ${typeLabel(t.of)}`;
  }
}

/** Run every defined-type WHERE rule that applies to `v` under its declared type, recursing into aggregates and typed SELECT values. */
function checkTypeRules(m: Model, id: number, entity: ResolvedEntity, attribute: string, v: Value, type: TypeRef, out: ValidationFinding[], counters: InstanceCheckCounters): void {
  if (v === undefined || v === DERIVED) return;
  if (type.k === 'aggregate') {
    if (Array.isArray(v)) for (const x of v) checkTypeRules(m, id, entity, attribute, x, type.of, out, counters);
    return;
  }
  if (type.k !== 'named') return;
  const decl = m.schema.type(type.name);
  if (!decl) return;
  if (decl.kind === 'select') {
    if (v instanceof Typed) checkTypeRules(m, id, entity, attribute, v.value, { k: 'named', name: v.type }, out, counters);
    return;
  }
  if (decl.kind !== 'defined') return;
  for (const { declaredBy, rule } of m.schema.typeRules.get(decl.name.toUpperCase()) ?? []) {
    counters.typeRuleEvaluations++;
    const ruleId = `${declaredBy}.${rule.label}`;
    const result = guard(out, ruleId, id, entity.name, () => rule.check(v, m));
    if (result.ok && violated(result.value)) {
      out.push({ category: 'simpletype_rule', rule: ruleId, instance: id, entity: entity.name, attribute, message: `${rule.source} is FALSE for ${describe(v)}` });
    }
  }
  if (decl.underlying.k === 'aggregate') checkTypeRules(m, id, entity, attribute, v, decl.underlying, out, counters);
}

export function checkInstance(m: Model, id: number, out: ValidationFinding[], counters: InstanceCheckCounters): void {
  const typeName = m.typeName(id) ?? '?';
  const entity = m.entityOf(id);
  if (!entity) {
    out.push({ category: 'schema', rule: 'unknown-entity', instance: id, message: `${typeName} is not an entity of ${m.schema.name}` });
    return;
  }
  const inst = m.get(id)!;
  const values = inst.attributes;
  const syntax = m.decodeErrors.get(id);
  if (syntax) {
    out.push({ category: 'schema', rule: 'record-syntax', instance: id, entity: entity.name, message: syntax });
    return;
  }
  if (entity.meta.abstract) {
    out.push({ category: 'schema', rule: 'abstract', instance: id, entity: entity.name, message: `Entity ${entity.name} is abstract` });
  }
  if (values.length !== entity.attributes.length) {
    out.push({
      category: 'schema', rule: 'attribute-count', instance: id, entity: entity.name,
      message: `${entity.name} has ${entity.attributes.length} attributes, the record has ${values.length}`,
    });
    return;
  }
  entity.attributes.forEach((a, i) => {
    const v = values[i];
    const attribute = `${entity.name}.${a.name}`;
    if (a.derived) {
      if (v !== DERIVED) out.push({ category: 'schema', rule: 'derived-in-subtype', instance: id, entity: entity.name, attribute, message: 'Attribute is derived in subtype' });
      return;
    }
    if (v === DERIVED) {
      out.push({ category: 'schema', rule: 'invalid-derived-marker', instance: id, entity: entity.name, attribute, message: '* used for an attribute that is not derived' });
      return;
    }
    if (v === undefined) {
      if (!a.optional) out.push({ category: 'schema', rule: 'not-optional', instance: id, entity: entity.name, attribute, message: 'Attribute not optional' });
      return;
    }
    if (!conforms(m, v, a.type)) {
      out.push({ category: 'schema', rule: 'invalid-type', instance: id, entity: entity.name, attribute, message: `${describe(v)} is not a valid ${typeLabel(a.type)}` });
      return;
    }
    checkTypeRules(m, id, entity, attribute, v, a.type, out, counters);
  });
  for (const inv of entity.inverses) {
    const count = m.inverse(inst, inv).length;
    const high = inv.high;
    if (count < inv.low || (high !== undefined && count > high)) {
      out.push({
        category: 'schema', rule: 'inverse-cardinality', instance: id, entity: entity.name, attribute: `${entity.name}.${inv.name}`,
        message: `${inv.name} : ${inv.aggregate ?? ''}${inv.aggregate ? ` [${inv.low}:${high ?? '?'}] OF ` : ''}${inv.entity} FOR ${inv.forAttribute} has ${count}`,
      });
    }
  }
}
