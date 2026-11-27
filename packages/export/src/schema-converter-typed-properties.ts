/* SPDX-License-Identifier: MPL-2.0 */

import type { IfcSourceBytes } from '@ifc-lite/parser';
import { IFC2X3_TYPED_PROPERTIES } from './generated/ifc2x3-typed-properties.js';
import { readStepSlots } from './step-argument-parser.js';
import { slotRef, slotUnset, type SourceRecords } from './schema-converter-structural-source.js';
import { getMaxExpressId, type CompleteEntityIndex } from './entity-iteration.js';
import { stepRecordHead } from './step-record-frame.js';
import { decodeRange } from './source-ref-bounds.js';
import { MAX_SOURCE_STEP_ID, isStepValue, parseStepNumber, skipStepTrivia } from './step-slot-grammar.js';
import type { StructuralDiagnostics } from './schema-converter-structural-diagnostics.js';
import type { Ifc4SlotCheck } from './schema-converter-ifc4-slots.js';
import type { IfcSchemaVersion } from './schema-converter.js';

let rows: ReadonlyMap<string, (typeof IFC2X3_TYPED_PROPERTIES)[number]> | undefined;

function rowFor(type: string) {
  return (rows ??= new Map(IFC2X3_TYPED_PROPERTIES.map((row) => [row[0], row]))).get(type);
}

export function isTypedPropertyUpgrade(type: string, from: IfcSchemaVersion, to: IfcSchemaVersion): boolean {
  return from === 'IFC2X3' && (to === 'IFC4' || to === 'IFC4X3') && rowFor(type) !== undefined;
}

// Recognize complete UTF-8 scalars so invalid bytes can retain their Latin-1
// meaning without changing adjacent valid UTF-8.
const UTF8_MULTIBYTE = /[\xc2-\xdf][\x80-\xbf]|\xe0[\xa0-\xbf][\x80-\xbf]|[\xe1-\xec\xee-\xef][\x80-\xbf]{2}|\xed[\x80-\x9f][\x80-\xbf]|\xf0[\x90-\xbf][\x80-\xbf]{2}|[\xf1-\xf3][\x80-\xbf]{3}|\xf4[\x80-\x8f][\x80-\xbf]{2}/g;

export function decodeTypedPropertyRecord(
  source: Uint8Array | IfcSourceBytes,
  ref: { type: string; byteOffset: number; byteLength: number },
  from: IfcSchemaVersion,
  to: IfcSchemaVersion,
): string {
  const end = ref.byteOffset + ref.byteLength;
  const decoded = decodeRange(source, ref.byteOffset, end);
  if (from !== 'IFC2X3' || (to !== 'IFC4' && to !== 'IFC4X3') || !decoded.includes('�')) {
    return decoded;
  }
  const row = rowFor(ref.type.toUpperCase());
  if (!row?.[2].some(([, fields]) => fields.some((field) => field.kind === 'text'))) {
    return decoded;
  }
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const byteString = Array.from(source.slice(ref.byteOffset, end), (byte) => String.fromCharCode(byte)).join('');
  return byteString.replace(UTF8_MULTIBYTE, (sequence) =>
    decoder.decode(Uint8Array.from(sequence, (char) => char.charCodeAt(0))));
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

function writableGroups(row: (typeof IFC2X3_TYPED_PROPERTIES)[number], slots: readonly string[]) {
  return row[2].flatMap(([name, fields]) => {
    const values = fields.filter((field) => wraps(slots[field.index], field));
    return values.length ? [{ name, fields: values }] : [];
  });
}

function nextAfterProperties(next: number, groupSizes: readonly number[], maxId = MAX_SOURCE_STEP_ID): number | undefined {
  if (!groupSizes.length) return undefined;
  const size = groupSizes.reduce((total, count) => total + count + 1, -1);
  return size - 1 <= maxId - next ? next + size : undefined;
}

/** Allocate in source iteration order as the default full STEP export does. */
export function previewTypedPropertyNames(
  records: SourceRecords,
  index: CompleteEntityIndex,
  candidates: readonly { type: string; ids: readonly number[]; referenceSlot: number }[],
): ReadonlyMap<number, ReadonlySet<string>> {
  const byId = new Map(candidates.flatMap((candidate) => candidate.ids.map((id) => [id, candidate] as const)));
  const retained = new Map<number, ReadonlySet<string>>();
  if (!byId.size) return retained;
  let next = getMaxExpressId(index) + 1;
  for (const [id] of index) {
    const candidate = byId.get(id);
    if (!candidate) continue;
    const slots = records.slots(id);
    const row = rowFor(candidate.type);
    if (!slots || !row || slots.length !== row[1]) continue;
    const names = new Set(row[2].flatMap(([, fields]) => fields
      .filter((field) => slotUnset(slots[field.index]))
      .map((field) => field.sourceName)));
    if (slotRef(slots[candidate.referenceSlot]) !== null) {
      const groups = writableGroups(row, slots);
      const end = nextAfterProperties(next, groups.map(({ fields }) => fields.length));
      if (end !== undefined) {
        next = end;
        for (const group of groups) for (const field of group.fields) names.add(field.sourceName);
      }
    }
    retained.set(id, names);
  }
  return retained;
}

/** Collect effective source values while writing, then allocate ids above all
 * emitted records (including federation offsets and synthesized atoms). */
export class TypedPropertyUpgrade {
  private refused = 0;
  private readonly drafts = new Map<number, Draft>();

  constructor(private readonly enabled: boolean) {}

  capture(source: string, converted: string, from: IfcSchemaVersion, to: IfcSchemaVersion, maxReferenceId = MAX_SOURCE_STEP_ID): boolean {
    if (!this.enabled || from !== 'IFC2X3' || (to !== 'IFC4' && to !== 'IFC4X3')) return false;
    const head = stepRecordHead(source);
    const sourceType = head ? source.slice(head.typeStart, head.typeEnd).toUpperCase() : '';
    const row = rowFor(sourceType);
    if (!row) return false;
    const input = readStepSlots(source, maxReferenceId);
    if (!input || input.slots.length !== row[1]) return false;
    const groups = writableGroups(row, input.slots).map(({ name, fields }) => ({
      name,
      properties: fields.map((field) => {
        const value = input.slots[field.index];
        return { attribute: field.sourceName, record: `IFCPROPERTYSINGLEVALUE('${field.name}',$,${field.valueType}(${value}),$);` };
      }),
    }));
    const id = idOf(converted);
    if (!groups.length || !(id <= maxReferenceId)) return false;
    this.drafts.set(id, { sourceType, to, groups });
    return true;
  }

  warnings(): string[] {
    return this.refused ? [`${this.refused} typed property record(s) could not be preserved because the target reference is missing or the export has run out of STEP ids (#10797).`] : [];
  }

  finish(lines: string[], slots: Ifc4SlotCheck, firstAvailableId: number, structural: StructuralDiagnostics, maxReferenceId = MAX_SOURCE_STEP_ID): number {
    if (this.drafts.size === 0) return firstAvailableId;
    const extra: string[] = [];
    let next = firstAvailableId;
    for (const line of lines) {
      const id = idOf(line);
      if (id >= next) next = id + 1;
    }
    const rewritten = (line: string, draft: Draft): string => {
      const record = readStepSlots(line, maxReferenceId);
      const end = nextAfterProperties(next, draft.groups.map((group) => group.properties.length), maxReferenceId);
      if (!record || record.slots.length !== 4 || slotRef(record.slots[3]) === null
        || end === undefined) {
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
      slots.apply(lines[index], draft.to);
    }
    for (const line of extra) lines.push(line);
    this.drafts.clear();
    return next;
  }
}
