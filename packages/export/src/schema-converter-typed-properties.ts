/* SPDX-License-Identifier: MPL-2.0 */

import { IFC2X3_TYPED_PROPERTIES } from './generated/ifc2x3-typed-properties.js';
import { readStepSlots } from './step-argument-parser.js';
import { slotRef, slotUnset } from './schema-converter-structural-source.js';
import { stepRecordHead } from './step-record-frame.js';
import { isStepValue, parseStepNumber, skipStepTrivia } from './step-slot-grammar.js';
import type { StructuralDiagnostics } from './schema-converter-structural-diagnostics.js';
import type { Ifc4SlotCheck } from './schema-converter-ifc4-slots.js';
import type { IfcSchemaVersion } from './schema-converter.js';

let rows: ReadonlyMap<string, (typeof IFC2X3_TYPED_PROPERTIES)[number]> | undefined;

function rowFor(type: string) {
  return (rows ??= new Map(IFC2X3_TYPED_PROPERTIES.map((row) => [row[0], row]))).get(type);
}
type Group = { name: string; properties: { attribute: string; record: string }[] };
type Draft = { sourceType: string; to: 'IFC4' | 'IFC4X3'; groups: Group[] };
type Field = (typeof IFC2X3_TYPED_PROPERTIES)[number][2][number][1][number];

function idOf(line: string): number {
  return Number(/^#(\d+)/.exec(line.slice(skipStepTrivia(line, 0)))?.[1]);
}

function wraps(value: string, field: Field): boolean {
  if (field.kind === 'number') return Number.isFinite(parseStepNumber(value));
  const start = skipStepTrivia(value, 0);
  if (field.kind === 'text') return value[start] === "'" && isStepValue(value);
  return /^(?:\.T\.|\.F\.)/i.test(value.slice(start))
    && skipStepTrivia(value, start + 3) === value.length;
}

/** Fields that have no value to lose or can be materialized on this record's target reference. */
export function retainedTypedPropertyNames(type: string, slots: readonly string[] | undefined, referenceSlot: number): ReadonlySet<string> {
  const row = rowFor(type);
  if (!slots || !row || slots.length !== row[1]) return new Set();
  const canWrite = slotRef(slots[referenceSlot]) !== null;
  return new Set(row[2].flatMap(([, fields]) => fields.filter((field) => {
    const value = slots[field.index];
    return slotUnset(value) || (canWrite && wraps(value, field));
  }).map((field) => field.sourceName)));
}

/** Collect effective source values while writing, then allocate ids above all
 * emitted records (including federation offsets and synthesized atoms). */
export class TypedPropertyUpgrade {
  private refused = 0;
  private readonly drafts = new Map<number, Draft>();

  constructor(private readonly enabled: boolean) {}

  capture(source: string, converted: string, from: IfcSchemaVersion, to: IfcSchemaVersion): boolean {
    if (!this.enabled || from !== 'IFC2X3' || (to !== 'IFC4' && to !== 'IFC4X3')) return false;
    const head = stepRecordHead(source);
    const sourceType = head ? source.slice(head.typeStart, head.typeEnd).toUpperCase() : '';
    const row = rowFor(sourceType);
    if (!row) return false;
    const input = readStepSlots(source);
    if (!input || input.slots.length !== row[1]) return false;
    const groups = row[2].flatMap(([name, fields]) => {
      const properties = fields.flatMap((field) => {
        const value = input.slots[field.index];
        return wraps(value, field) ? [{ attribute: field.sourceName, record: `IFCPROPERTYSINGLEVALUE('${field.name}',$,${field.valueType}(${value}),$);` }] : [];
      });
      return properties.length ? [{ name, properties }] : [];
    });
    const id = idOf(converted);
    if (!groups.length || !(id <= 0xffffffff)) return false;
    this.drafts.set(id, { sourceType, to, groups });
    return true;
  }

  warnings(): string[] {
    return this.refused ? [`${this.refused} typed property record(s) could not be preserved because the target reference is missing or the export has run out of STEP ids (#10797).`] : [];
  }

  finish(lines: string[], slots: Ifc4SlotCheck, firstAvailableId: number, structural: StructuralDiagnostics): number {
    if (this.drafts.size === 0) return firstAvailableId;
    const extra: string[] = [];
    let next = firstAvailableId;
    for (const line of lines) {
      const id = idOf(line);
      if (id >= next) next = id + 1;
    }
    const rewritten = (line: string, draft: Draft): string => {
      const record = readStepSlots(line);
      const size = draft.groups.reduce((n, group) => n + group.properties.length + 1, -1);
      if (!record || record.slots.length !== 4 || slotRef(record.slots[3]) === null
        || next + size - 1 > 0xffffffff) {
        this.refused++;
        return line;
      }
      let parent = line;
      for (const [index, group] of draft.groups.entries()) {
        const refs = group.properties.map((property) => {
          const ref = `#${next++}`;
          extra.push(`${ref}=${property.record}`);
          structural.restoreOmittedValue(draft.sourceType, property.attribute, draft.to);
          return ref;
        });
        const args = `'${group.name}',$,(${refs.join(',')}),${record.slots[3]}`;
        if (index === 0) parent = `${record.prefix}${args}${record.suffix}`;
        else extra.push(`#${next++}=${record.type}(${args});`);
      }
      return parent;
    };
    for (let index = 0; index < lines.length; index++) {
      const draft = this.drafts.get(idOf(lines[index]));
      if (!draft) continue;
      lines[index] = rewritten(lines[index], draft);
      if (draft.to === 'IFC4') slots.apply(lines[index]);
    }
    for (const line of extra) lines.push(line);
    this.drafts.clear();
    return next;
  }
}
