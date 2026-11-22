/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Values a target slot cannot hold, after conversion (#10847). The slots and
 * their rejected forms come from `schema-value-form-policy.ts`, run against
 * the registries once per type; a value of a rejected form is written `$`,
 * one a policy row converts is wrapped or unwrapped, and anything else stays.
 * An aggregate loses only its rejected members, unless they are positional:
 * then it and the slots it pairs with are emptied, each as below. A required aggregate
 * that may be empty and loses every member is written `()`. Twin of Rust
 * `schema_value_forms.rs`, which reads the same rows from
 * `generated/value_forms.rs` (`scripts/generate-value-forms.mjs --check`).
 */

import { getCanonicalEntityName, getSchemaRegistryForVersion, type SchemaVersionWithRegistry } from '@ifc-lite/parser';
import { CalendarDates } from './schema-calendar-dates.js';
import { valueForm, valueFormSlotsOf } from './schema-value-form-policy.js';
import { getAttrMaps } from './schema-converter-attr-maps.js';
import { withoutComments } from './step-comment-skip.js';
import { listItems } from './schema-converter-structural-axes.js';
import { readStepSlots } from './step-argument-parser.js';
import { DURATION_TIME_UNIT_WARNING, durationFromSeconds, durationToSeconds, hasNonSecondProjectTimeUnit } from './schema-converter-durations.js';
import type { SourceStore } from './schema-converter-structural-source.js';
import { stepRecordHead } from './step-record-frame.js';
import { isStepValue, parseStepNumber, skipStepTrivia } from './step-slot-grammar.js';

interface Rule {
  readonly index: number;
  readonly where: string;
  readonly required: boolean;
  /** The target aggregate may be empty. */
  readonly empty: boolean;
  /** Slots emptied together when a positional member is rejected. */
  readonly whole: readonly number[];
  /** Form -> null (drop), `T:NAME` (wrap), `U` (unwrap), `U1` (one member) or an integer form (`I`, `AI`). */
  readonly forms: ReadonlyMap<string, string | null>;
  /** Typed forms with a payload row (`T:NAME(F)`), the only ones whose payload is read. */
  readonly payload: ReadonlySet<string>;
  readonly hasCalendar: boolean;
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
  const slots = entity === undefined ? [] : valueFormSlotsOf(source, target, from, to, getAttrMaps(), entity);
  const meta = entity === undefined ? undefined : target.entities[entity];
  rules = !meta || !slots.length ? NONE : { arity: (meta.allAttributes ?? meta.attributes).length, rules: slots.map((slot) => ({
    index: slot.index,
    where: `${type}.${slot.attribute}`,
    required: slot.required,
    empty: slot.empty,
    whole: slot.whole,
    forms: new Map(slot.rejected.map((f) => [f.split('>')[0], f.split('>')[1] ?? null])),
    hasCalendar: slot.rejected.some((f) => f.includes('>C')),
    payload: new Set(slot.rejected.filter((f) => f.split('>')[0].endsWith(')')).map((f) => f.slice(0, f.indexOf('(')))),
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

/** A typed value's argument, `NAME(arg)` -> `arg`. */
function unwrapped(body: string): string | null {
  const close = body.lastIndexOf(')');
  return close < 0 ? null : body.slice(body.indexOf('(') + 1, close).trim();
}

/** Retype exactly one STEP string without decoding its escapes. */
function asText(value: string | null): string | null {
  return value?.startsWith("'") && isStepValue(value) ? 'IFCTEXT(' + value + ')' : null;
}

/** The one member of an aggregate; null for any other count. */
function onlyMember(list: string | null): string | null {
  const members = list === null ? null : listItems(list);
  return members?.length === 1 ? members[0].trim() : null;
}

/** A whole STEP real as an integer token; null for a fraction or one past the safe range. */
function asInteger(token: string): string | null {
  const n = parseStepNumber(token);
  return wholeDecimal(token) && Number.isSafeInteger(n) ? String(n) : null;
}

/** A typed `NAME(payload)` whose payload form a `T:NAME(F)` row converts (`I`) or drops. */
function narrowed(value: string, body: string, form: string, rule: Rule): { value: string | null; lost: number } {
  const arg = unwrapped(body), payload = arg === null ? null : valueForm(arg);
  const to = payload === null ? undefined : rule.forms.get(`${form}(${payload})`);
  if (to === undefined) return { value, lost: 0 };
  const int = to === 'I' ? asInteger(arg!) : null;
  return int === null ? { value: null, lost: 1 } : { value: `${body.slice(0, body.indexOf('(')).trimEnd()}(${int})`, lost: 0 };
}

/** `value` in the target's form (null to drop it), and how many values that lost. */
function fix(value: string, prefix: string, rule: Rule, markDuration: () => void): { value: string | null; lost: number } {
  const start = skipStepTrivia(value, 0);
  if (start < 0) return { value, lost: 0 };
  if (value[start] === '(') {
    const members = listItems(value);
    if (!members) return { value, lost: 0 };
    const kept: string[] = [];
    let lost = 0;
    for (const member of members) {
      const fixed = fix(member, `${prefix}A`, rule, markDuration);
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
  if (to === undefined) return form !== null && rule.payload.has(prefix + form) ? narrowed(value, body, prefix + form, rule) : { value, lost: 0 };
  // The shared STEP number grammar gates the integer form; `wholeDecimal` reads the digits.
  const fixed = to === null ? null
    : to.startsWith('T:') ? `${to.slice(2)}(${body})`
    : to === 'TEXT' ? asText(unwrapped(body))
    : to === 'D+' ? durationFromSeconds(body)
    : to === 'D-' ? durationToSeconds(body)
    : to === 'U' ? unwrapped(body)
    : to === 'U1' ? onlyMember(unwrapped(body))
    : asInteger(body); // an integer form, `I` or `AI`
  // A set of references that could not be unwrapped loses each of them, and at least one value,
  // so an emptied slot is always named.
  if (fixed !== null && (to === 'D+' || to === 'D-')) markDuration();
  const inner = to === 'U1' ? unwrapped(body) : null;
  const lost = fixed === null ? Math.max(1, inner === null ? 1 : valueCount(inner)) : 0;
  return { value: fixed, lost };
}

/** Value-form reconciliation for one export: rewrites, and names what it dropped. */
export class ValueForms {
  /** Per `TYPE.Attribute`: values dropped, and those that left a required slot `$`. */
  private readonly dropped = new Map<string, number>();
  private readonly emptied = new Map<string, number>();
  private readonly narrowedDates = new Map<string, number>();
  readonly dates: CalendarDates;
  private durationConverted = false;
  private readonly markDuration = () => { this.durationConverted = true; };

  constructor(deferDates = false, private readonly timeUnitSources: readonly SourceStore[] = []) { this.dates = new CalendarDates(deferDates); }

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
      const form = rule.hasCalendar ? valueForm(withoutComments(slots[rule.index])) : null;
      const calendar = form === null ? null : rule.forms.get(form);
      if (calendar?.startsWith('C') && this.dates.defer(line, rule.index, calendar,
        (narrowed) => this.count(narrowed ? this.narrowedDates : rule.required ? this.emptied : this.dropped, rule.where, 1))) continue;
      const fixed = fix(slots[rule.index], '', rule, this.markDuration);
      if (fixed.lost && rule.whole.length) {
        // Positional members: every slot of the group goes whole, each named for what it held.
        for (const i of rule.whole) {
          // The generator gives every slot of a group a row like this one.
          const own = rules.find((r) => r.index === i), held = own ? valueCount(slots[i]) : 0;
          if (!own || !held) continue;
          const emptied = own.empty && own.required ? '()' : '$';
          this.count(emptied === '$' && own.required ? this.emptied : this.dropped, own.where, held);
          slots[i] = emptied;
          changed = true;
        }
        continue;
      }
      let { value } = fixed;
      if (value === null && rule.empty && rule.required) value = '()';
      if (fixed.lost) this.count(value === null && rule.required ? this.emptied : this.dropped, rule.where, fixed.lost);
      value ??= '$';
      if (value !== slots[rule.index]) {
        slots[rule.index] = value;
        changed = true;
      }
    }
    return changed ? `${record.prefix}${slots.join(',')}${record.suffix}` : line;
  }

  private count(into: Map<string, number>, where: string, n: number): void {
    into.set(where, (into.get(where) ?? 0) + n);
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
      ...this.dates.warnings(),
      ...(this.narrowedDates.size ? [
        `${[...this.narrowedDates.values()].reduce((sum, count) => sum + count, 0)} date value(s) kept the calendar date and dropped the time and any timezone: ${[...this.narrowedDates.keys()].sort().join(', ')} (#10879).`,
      ] : []),
      ...(this.durationConverted && this.timeUnitSources.some(hasNonSecondProjectTimeUnit) ? [DURATION_TIME_UNIT_WARNING] : []),
    ];
  }
}
