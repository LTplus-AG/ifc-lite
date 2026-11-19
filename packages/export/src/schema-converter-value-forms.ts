/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Values a target slot cannot hold, after conversion (#10847). The slots and
 * their rejected forms come from `schema-value-form-policy.ts`, run against
 * the registries once per type; a value of a rejected form is written `$`,
 * one a policy row converts is wrapped or unwrapped, and anything else stays.
 * An aggregate loses only its rejected members. Twin of Rust
 * `schema_value_forms.rs`, which reads the same rows from
 * `generated/value_forms.rs` (`scripts/generate-value-forms.mjs --check`).
 */

import { getCanonicalEntityName, getSchemaRegistryForVersion, type SchemaVersionWithRegistry } from '@ifc-lite/parser';
import { valueForm, valueFormSlotsOf } from './schema-value-form-policy.js';
import { ATTR_MAPS } from './schema-converter-attr-maps.js';
import { listItems } from './schema-converter-structural-axes.js';
import { readStepSlots } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';
import { skipStepTrivia } from './step-slot-grammar.js';

interface Rule {
  readonly index: number;
  readonly where: string;
  /** Form -> null (drop), `T:NAME` (wrap), `U` (unwrap) or an integer form (`I`, `AI`). */
  readonly forms: ReadonlyMap<string, string | null>;
}

const SCHEMAS = new Set(['IFC2X3', 'IFC4', 'IFC4X3']);
/** A target type's attribute count and its rules. */
interface Rules { readonly arity: number; readonly rules: readonly Rule[] }

const RULES = new Map<string, Map<string, Rules>>();
const NONE: Rules = { arity: 0, rules: [] };

function rulesFor(from: string, to: string, type: string): Rules {
  const key = `${from}>${to}`;
  let byType = RULES.get(key);
  if (!byType) RULES.set(key, (byType = new Map()));
  let rules = byType.get(type);
  if (rules) return rules;
  const source = getSchemaRegistryForVersion(from as SchemaVersionWithRegistry);
  const target = getSchemaRegistryForVersion(to as SchemaVersionWithRegistry);
  const entity = getCanonicalEntityName(target, type);
  const slots = entity === undefined ? [] : valueFormSlotsOf(source, target, from, to, ATTR_MAPS, entity);
  const meta = entity === undefined ? undefined : target.entities[entity];
  rules = !meta || !slots.length ? NONE : { arity: (meta.allAttributes ?? meta.attributes).length, rules: slots.map((slot) => ({
    index: slot.index,
    where: `${type}.${slot.attribute}`,
    forms: new Map(slot.rejected.map((f) => [f.split('>')[0], f.split('>')[1] ?? null])),
  })) };
  byType.set(type, rules);
  return rules;
}

/** `value` in the target's form, null to drop it, plus the members it dropped. */
function fix(value: string, prefix: string, rule: Rule): { value: string | null; dropped: number } {
  const start = skipStepTrivia(value, 0);
  if (start < 0) return { value, dropped: 0 };
  const body = value.slice(start);
  if (body[0] === '(') {
    const members = listItems(value);
    if (!members) return { value, dropped: 0 };
    const kept: string[] = [];
    let dropped = 0;
    for (const member of members) {
      const fixed = fix(member, `${prefix}A`, rule);
      dropped += fixed.dropped + (fixed.value === null ? 1 : 0);
      if (fixed.value !== null) kept.push(fixed.value);
    }
    if (!dropped && kept.every((m, i) => m === members[i])) return { value, dropped: 0 };
    return { value: kept.length ? `(${kept.join(',')})` : null, dropped };
  }
  const form = valueForm(body);
  if (form === null) return { value, dropped: 0 };
  const to = rule.forms.get(prefix + form);
  if (to === undefined) return { value, dropped: 0 };
  if (to === null) return { value: null, dropped: 0 };
  if (to === 'U') return { value: body.slice(body.indexOf('(') + 1, body.lastIndexOf(')')).trim(), dropped: 0 };
  if (to.endsWith('I')) {
    const n = Number(body.trim());
    return { value: Number.isSafeInteger(n) ? String(n) : null, dropped: 0 };
  }
  return { value: `${to.slice(2)}(${body.trim()})`, dropped: 0 };
}

/** Value-form reconciliation for one export: rewrites, and names what it dropped. */
export class ValueForms {
  private readonly dropped = new Map<string, number>();

  /** `line`, already converted from `from` to `to`, with every slot in a form the target accepts. */
  apply(line: string, from: string, to: string): string {
    if (!SCHEMAS.has(from) || !SCHEMAS.has(to) || from === to) return line;
    // The head names the type; most records stop before their slots are split.
    const head = stepRecordHead(line);
    const { arity, rules } = head ? rulesFor(from, to, line.slice(head.typeStart, head.typeEnd).toUpperCase()) : NONE;
    const record = rules.length ? readStepSlots(line) : null;
    // A record whose arity is not the target's is left alone: slot i need not be attribute i.
    if (!record || record.slots.length !== arity) return line;
    const slots = [...record.slots];
    let changed = false;
    for (const rule of rules) {
      if (rule.index >= slots.length) continue;
      const fixed = fix(slots[rule.index], '', rule);
      const lost = fixed.dropped + (fixed.value === null ? 1 : 0);
      if (lost) this.dropped.set(rule.where, (this.dropped.get(rule.where) ?? 0) + lost);
      const value = fixed.value ?? '$';
      if (value !== slots[rule.index]) {
        slots[rule.index] = value;
        changed = true;
      }
    }
    return changed ? `${record.prefix}${slots.join(',')}${record.suffix}` : line;
  }

  /** One warning naming every slot a value was dropped from (#10847). */
  warnings(): string[] {
    if (!this.dropped.size) return [];
    const total = [...this.dropped.values()].reduce((a, b) => a + b, 0);
    const sites = [...this.dropped.keys()].sort().join(', ');
    return [`${total} value(s) of a type the target slot does not accept were written as $: ${sites} (#10847).`];
  }
}
