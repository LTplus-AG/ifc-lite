/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Checks over whole populations: entity WHERE rules, UNIQUE rules, global RULEs and GlobalId format. */

import { attr } from '../runtime/access.js';
import { EntityInstance } from '../runtime/instance.js';
import { violated } from '../runtime/logic.js';
import type { Model } from '../runtime/model.js';
import type { TypeRef } from '../runtime/schema-meta.js';
import { BinaryValue, EnumValue, prim, Typed, type Value } from '../runtime/values.js';
import type { ValidationFinding } from './findings.js';
import { guard } from './guard.js';

export function checkEntityRules(m: Model, out: ValidationFinding[], include?: (entity: string) => boolean): number {
  let evaluations = 0;
  for (const id of m.ids()) {
    const inst = m.get(id);
    if (!inst || (include && !include(inst.entity.name))) continue;
    for (const { declaredBy, rule } of inst.entity.rules) {
      evaluations++;
      const ruleId = `${declaredBy}.${rule.label}`;
      const result = guard(out, ruleId, id, inst.entity.name, () => rule.check(inst, m));
      if (result.ok && violated(result.value)) {
        out.push({ category: 'entity_rule', rule: ruleId, instance: id, entity: inst.entity.name, message: rule.source });
      }
    }
  }
  return evaluations;
}

export function checkGlobalRules(m: Model, out: ValidationFinding[]): void {
  for (const rule of m.schema.rules.global) {
    guard(out, rule.name, undefined, undefined, () => {
      for (const [label, value] of rule.run(m)) {
        if (!violated(value)) continue;
        const source = rule.rules.find((r) => r.label === label)?.source ?? label;
        out.push({ category: 'global_rule', rule: `${rule.name}.${label}`, message: `${source} is FALSE for the population of ${rule.appliesTo.join(', ')}` });
      }
      return undefined;
    });
  }
}

function uniqueKey(m: Model, v: Value, type?: TypeRef): string | undefined {
  if (v instanceof Typed) {
    const value = uniqueKey(m, v.value, { k: 'named', name: v.type });
    return value === undefined ? undefined : JSON.stringify(['typed', v.type, value]);
  }
  if (Array.isArray(v)) {
    const agg = m.schema.aggregateType(type);
    const parts = v.map(item => uniqueKey(m, item, agg?.of));
    if (parts.includes(undefined)) return undefined;
    if (agg?.kind === 'SET' || agg?.kind === 'BAG') parts.sort();
    return JSON.stringify(['aggregate', parts]);
  }
  const p = prim(v);
  if (p instanceof BinaryValue) return `binary:${p.hex.toUpperCase()}`;

  if (p === undefined) return undefined;
  if (typeof p === 'string' || typeof p === 'number' || typeof p === 'boolean') return `${typeof p}:${String(p)}`;
  if (p instanceof EnumValue) return `enum:${p.name}`;
  if (p instanceof EntityInstance) return `#${p.id}`;
  return undefined;
}

/** UNIQUE rules: within the population of the declaring entity, no two instances share the attribute value tuple. */
export function checkUniqueRules(m: Model, out: ValidationFinding[]): void {
  for (const entity of m.schema.entities.values()) {
    for (const unique of entity.meta.unique ?? []) {
      const seen = new Map<string, EntityInstance>();
      const names = unique.attributes.map((a) => a.toUpperCase());
      for (const inst of m.population(entity.name)) {
        const parts = names.map((n) => {
          const slot = inst.entity.slot(n, entity.upper);
          return uniqueKey(m, attr(inst, n, entity.upper), slot?.k === 'explicit' ? slot.attribute.type : undefined);
        });
        if (parts.some((p) => p === undefined)) continue;
        const key = JSON.stringify(parts);
        const first = seen.get(key);
        if (!first) {
          seen.set(key, inst);
          continue;
        }
        out.push({
          category: 'unique_rule', rule: `${entity.name}.${unique.label}`, instance: inst.id, entity: inst.entity.name,
          attribute: `${entity.name}.${unique.attributes.join(', ')}`,
          message: `${unique.attributes.join(', ')} must be unique; also used by #${first.id}`,
        });
      }
    }
  }
}

const GUID_CHARS = /^[0-9A-Za-z_$]{22}$/;

/** IfcGloballyUniqueId content: 22 characters of the IFC base64 alphabet encoding 128 bits (first character 0-3). */
export function checkGlobalIds(m: Model, out: ValidationFinding[]): void {
  for (const id of m.ids()) {
    const inst = m.get(id);
    const slot = inst?.entity.slots.get('GLOBALID');
    if (!inst || slot?.k !== 'explicit') continue;
    const v = inst.attributes[slot.index];
    if (typeof v !== 'string') continue;
    const problem = v.length !== 22
      ? 'Guid length should be 22 characters.'
      : !'0123'.includes(v[0])
        ? 'Guid first character must be either a 0, 1, 2, or 3.'
        : !GUID_CHARS.test(v)
          ? 'Guid contains invalid characters.'
          : undefined;
    if (problem) out.push({ category: 'schema', rule: 'guid-format', instance: id, entity: inst.entity.name, attribute: `${inst.entity.name}.GlobalId`, message: problem });
  }
}
