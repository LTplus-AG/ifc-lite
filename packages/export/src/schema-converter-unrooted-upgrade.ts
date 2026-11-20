/* SPDX-License-Identifier: MPL-2.0 */

import { getSchemaRegistryForVersion } from '@ifc-lite/parser';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { frameArgs, stepRecordHead, stepRecordFrame, withFrameArgs, type StepRecordFrame } from './step-record-frame.js';
import { forEachExpressRef, referencesAnyExpressId } from './step-ref-scan.js';
import { OMIT_ON_UPGRADE } from './schema-untranslatable.js';
import { isStepValue, skipStepTrivia } from './step-slot-grammar.js';

type OutputRecord = { id: number; type: string; line: string; raw: string; frame: StepRecordFrame | null };
type Attribute = { optional: boolean; isList: boolean; isSet: boolean; arrayBounds?: readonly [number, number] };
type Slot = { value: string; optional: boolean; members: string[] | null; minimum: number };
type Group = { id: number; remaining: number; minimum: number };
type Member = { group: Group; lost: boolean };

const registry = () => getSchemaRegistryForVersion('IFC4').entities;
let layouts: Map<string, readonly Attribute[]> | undefined;

function attributes(type: string): readonly Attribute[] | undefined {
  layouts ??= new Map(Object.entries(registry()).map(([name, info]) => [
    name.toUpperCase(), info.allAttributes ?? info.attributes,
  ]));
  return layouts.get(type);
}

function recordId(line: string): number {
  const start = skipStepTrivia(line, 0);
  return Number(/^#(\d+)/.exec(line.slice(start))?.[1]);
}

function record(line: string): OutputRecord | undefined {
  const head = stepRecordHead(line);
  if (head === null) return undefined;
  const id = recordId(line);
  if (!(id <= 0xffffffff)) return undefined;
  const type = line.slice(head.typeStart, head.typeEnd).toUpperCase();
  const frame = stepRecordFrame(line);
  const raw = frame ? frameArgs(line, frame) : line.slice(head.open + 1);
  return { id, type, line, raw, frame };
}

/** Collect a direct omission only from the IFC2X3 input of an IFC4 upgrade. */
export function noteUnrootedUpgradeSeed(line: string, seeds: Set<number>): void {
  const head = stepRecordHead(line);
  if (head && OMIT_ON_UPGRADE.has(line.slice(head.typeStart, head.typeEnd).toUpperCase())) {
    const id = recordId(line);
    if (id <= 0xffffffff) seeds.add(id);
  }
}

function listMembers(value: string): string[] | null {
  const open = skipStepTrivia(value, 0);
  if (value[open] !== '(' || !isStepValue(value)) return null;
  // isStepValue verifies that the outer list is followed only by STEP trivia.
  // Look past its comments before choosing the closing parenthesis.
  let end = value.length;
  while (end > open) {
    const close = value.lastIndexOf(')', end - 1);
    if (close <= open) return null;
    if (skipStepTrivia(value, close + 1) === value.length) {
      const items = splitTopLevelStepArguments(value.slice(open + 1, close));
      if (items !== null) return items;
    }
    end = close;
  }
  return null;
}

function slot(value: string, attribute?: Attribute): Slot {
  const members = attribute?.isList || attribute?.isSet ? listMembers(value) : null;
  return { value, members, optional: attribute?.optional ?? false, minimum: members ? attribute?.arrayBounds?.[0] ?? 1 : 1 };
}

function readSlots(rec: OutputRecord): Slot[] {
  const values = rec.frame ? splitTopLevelStepArguments(rec.raw) : null;
  const layout = attributes(rec.type);
  // If the target layout cannot be established, the record is only safe when
  // none of its references is lost. Treat the entire argument list as required.
  if (!values || !layout || values.length !== layout.length) return [slot(rec.raw)];
  return values.map((value, index) => slot(value, layout[index]));
}

function indexRequiredMembers(rec: OutputRecord, users: Map<number, Member[]>): void {
  for (const part of readSlots(rec)) {
    if (part.optional || part.minimum === 0) continue;
    const members = part.members ?? [part.value];
    const group = { id: rec.id, remaining: members.length, minimum: part.minimum };
    for (const value of members) {
      let member: Member | undefined;
      forEachExpressRef(value, (ref) => {
        const entries = users.get(ref) ?? [];
        entries.push(member ??= { group, lost: false });
        users.set(ref, entries);
        return false;
      });
    }
  }
}

function cascadeOmissions(records: readonly (OutputRecord | undefined)[], seeds: ReadonlySet<number>): Set<number> {
  const dropped = new Set(seeds);
  const users = new Map<number, Member[]>();
  for (const rec of records) {
    if (rec && !dropped.has(rec.id)) indexRequiredMembers(rec, users);
  }
  // Set iteration visits newly inserted ids. Each reference edge is visited
  // once. A member that names several dropped records counts as one loss.
  for (const id of dropped) {
    for (const member of users.get(id) ?? []) {
      if (member.lost || dropped.has(member.group.id)) continue;
      member.lost = true;
      if (--member.group.remaining < member.group.minimum) dropped.add(member.group.id);
    }
  }
  return dropped;
}

function rewrite(rec: OutputRecord, dropped: ReadonlySet<number>): string {
  if (!rec.frame || !referencesAnyExpressId(rec.raw, dropped)) return rec.line;
  const layout = attributes(rec.type);
  const values = splitTopLevelStepArguments(rec.raw);
  if (!layout || !values || values.length !== layout.length) return rec.line;
  const kept = values.map((value, index) => {
    if (!referencesAnyExpressId(value, dropped)) return value;
    const { members, minimum } = slot(value, layout[index]);
    const filtered = members?.filter((member) => !referencesAnyExpressId(member, dropped));
    return filtered && filtered.length >= minimum ? `(${filtered.join(',')})` : '$';
  });
  return withFrameArgs(rec.line, rec.frame, kept.join(','));
}

/** Run after conversion so every reference is in the final id space and slot. */
export function omitUnrootedUpgrade(lines: string[], seeds: ReadonlySet<number>): string[] {
  if (seeds.size === 0) return [];
  const records = lines.map(record);
  const dropped = cascadeOmissions(records, seeds);
  const warnings: string[] = [];
  let next = 0;
  for (const [index, rec] of records.entries()) {
    if (rec && dropped.has(rec.id)) {
      const reason = seeds.has(rec.id) ? 'the IFC4 schema does not declare its type' : 'a required IFC4 attribute lost a reference';
      warnings.push(`#${rec.id} (${rec.type}) was omitted because ${reason} (#10970).`);
    } else {
      lines[next++] = rec ? rewrite(rec, dropped) : lines[index];
    }
  }
  lines.length = next;
  return warnings;
}


/** Single-model output contains only converted records, including pending edits. */
export function pruneUnrootedUpgrade(lines: string[]): string[] {
  const seeds = new Set<number>();
  for (const line of lines) noteUnrootedUpgradeSeed(line, seeds);
  return omitUnrootedUpgrade(lines, seeds);
}
