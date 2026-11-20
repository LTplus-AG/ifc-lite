/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Values a target slot cannot hold, after conversion (#10847). The slots and
 * their rejected forms come from `schema-value-form-policy.ts`, run against
 * the registries once per type; a value of a rejected form is written `$`,
 * one a policy row converts is wrapped or unwrapped, and anything else stays.
 * An aggregate loses only its rejected members, unless they are positional:
 * then it and the slots it pairs with are written `$`. A required aggregate
 * that may be empty and loses every member is written `()`. Twin of Rust
 * `schema_value_forms.rs`, which reads the same rows from
 * `generated/value_forms.rs` (`scripts/generate-value-forms.mjs --check`).
 */

import { getCanonicalEntityName, getSchemaRegistryForVersion, type SchemaVersionWithRegistry } from '@ifc-lite/parser';
import { valueForm, valueFormSlotsOf } from './schema-value-form-policy.js';
import { ATTR_MAPS } from './schema-converter-attr-maps.js';
import { withoutComments } from './step-comment-skip.js';
import { listItems } from './schema-converter-structural-axes.js';
import { readStepSlots } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';
import { parseStepNumber, skipStepTrivia } from './step-slot-grammar.js';

interface Rule {
  readonly index: number;
  readonly where: string;
  readonly required: boolean;
  /** The target aggregate may be empty. */
  readonly empty: boolean;
  /** Slots written `$` together when a positional member is rejected. */
  readonly whole: readonly number[];
  /** Form -> null (drop), `T:NAME` (wrap), `U` (unwrap), `U1` (one member) or an integer form (`I`, `AI`). */
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
    required: slot.required,
    empty: slot.empty,
    whole: slot.whole,
    forms: new Map(slot.rejected.map((f) => [f.split('>')[0], f.split('>')[1] ?? null])),
  })) };
  byType.set(type, rules);
  return rules;
}

/** Whether a STEP real is a whole number, read from its digits: float rounding would make
 *  `2.0000000000000001` whole. Every digit after the point, once the exponent moves it, is 0. */
function wholeDecimal(token: string): boolean {
  const m = /^[+-]?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(token);
  return !!m && /^0*$/.test(`${m[1]}${m[2] ?? ''}`.slice(Math.max(m[1].length + Number(m[3] ?? 0), 0)));
}

/** How many values a slot holds: its members, or one unless it is `$`. */
function valueCount(slot: string): number {
  return listItems(slot)?.length ?? (valueForm(withoutComments(slot)) === null ? 0 : 1);
}

/** `value` in the target's form (null to drop it), and how many values that lost. */
function fix(value: string, prefix: string, rule: Rule): { value: string | null; lost: number } {
  const start = skipStepTrivia(value, 0);
  if (start < 0) return { value, lost: 0 };
  if (value[start] === '(') {
    const members = listItems(value);
    if (!members) return { value, lost: 0 };
    const kept: string[] = [];
    let lost = 0;
    for (const member of members) {
      const fixed = fix(member, `${prefix}A`, rule);
      lost += fixed.lost;
      if (fixed.value !== null) kept.push(fixed.value);
    }
    if (!lost && kept.every((m, i) => m === members[i])) return { value, lost: 0 };
    return { value: kept.length ? `(${kept.join(',')})` : null, lost };
  }
  // Classified and converted without comments, so a trailing `/* .. */` changes nothing.
  const body = withoutComments(value);
  const form = valueForm(body);
  const to = form === null ? undefined : rule.forms.get(prefix + form);
  if (to === undefined) return { value, lost: 0 };
  // The shared STEP number grammar gates the integer form; `wholeDecimal` reads the digits.
  const close = body.lastIndexOf(')'), n = parseStepNumber(body);
  const inner = close < 0 ? null : body.slice(body.indexOf('(') + 1, close).trim();
  const one = to === 'U1' && inner !== null ? listItems(inner) : null;
  const fixed = to === null ? null
    : to.startsWith('T:') ? `${to.slice(2)}(${body})`
    : to === 'U' ? inner
    : to === 'U1' ? (one?.length === 1 ? one[0].trim() : null)
    : wholeDecimal(body) && Number.isSafeInteger(n) ? String(n) : null; // an integer form, `I` or `AI`
  return { value: fixed, lost: fixed === null ? 1 : 0 };
}

/** Value-form reconciliation for one export: rewrites, and names what it dropped. */
export class ValueForms {
  /** Per `TYPE.Attribute`: values dropped, and those that left a required slot `$`. */
  private readonly dropped = new Map<string, number>();
  private readonly emptied = new Map<string, number>();

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
      let { lost, value } = fixed;
      if (lost && rule.whole.length) {
        // Positional members: the aggregate and its partners go whole.
        lost = rule.whole.reduce((sum, i) => sum + valueCount(slots[i]), 0);
        for (const i of rule.whole) {
          if (i !== rule.index && slots[i] !== '$') { slots[i] = '$'; changed = true; }
        }
        value = null;
      }
      if (value === null && rule.empty && rule.required) value = '()';
      const into = value === null && rule.required ? this.emptied : this.dropped;
      if (lost) into.set(rule.where, (into.get(rule.where) ?? 0) + lost);
      value ??= '$';
      if (value !== slots[rule.index]) {
        slots[rule.index] = value;
        changed = true;
      }
    }
    return changed ? `${record.prefix}${slots.join(',')}${record.suffix}` : line;
  }

  /** One warning per kind, naming every slot a value was dropped from (#10847). */
  warnings(): string[] {
    const line = (where: Map<string, number>, what: string) => {
      const total = [...where.values()].reduce((a, b) => a + b, 0);
      return where.size ? [`${total} value(s) of a type the target slot does not accept ${what}: ${[...where.keys()].sort().join(', ')} (#10847).`] : [];
    };
    return [
      ...line(this.dropped, 'were dropped'),
      ...line(this.emptied, 'left a slot the target requires as $, so the file is not valid against its header'),
    ];
  }
}
