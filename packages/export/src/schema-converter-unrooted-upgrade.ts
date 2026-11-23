/* SPDX-License-Identifier: MPL-2.0 */

import { getSchemaRegistryForVersion } from '@ifc-lite/parser';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { frameArgs, stepRecordHead, stepRecordFrame, withFrameArgs, type StepRecordFrame } from './step-record-frame.js';
import { forEachExpressRef, referencesAnyExpressId } from './step-ref-scan.js';
import { isRootedEntityType, missingTypeRoute, OMIT_ON_UPGRADE } from './schema-untranslatable.js';
import { attrNameTable, convertEntityType, convertStepLine, type IfcSchemaVersion } from './schema-converter.js';
import { SourceRecords, type SourceStore } from './schema-converter-structural-source.js';
import { isStepValue, skipStepTrivia } from './step-slot-grammar.js';

type OutputRecord = { id: number; type: string; line: string; raw: string; frame: StepRecordFrame | null };
type Attribute = { optional: boolean; isList: boolean; isSet: boolean; arrayBounds?: readonly [number, number] };
type Slot = { value: string; optional: boolean; members: string[] | null; minimum: number };
type Group = { id: number; remaining: number; minimum: number };
type Member = { group: Group; lost: boolean };

type UpgradeSchema = 'IFC4' | 'IFC2X3';
const layouts = new Map<UpgradeSchema, Map<string, readonly Attribute[]>>();

function attributes(schema: UpgradeSchema, type: string): readonly Attribute[] | undefined {
  let layout = layouts.get(schema);
  if (!layout) {
    const entities = getSchemaRegistryForVersion(schema).entities;
    layout = new Map(Object.entries(entities).map(([name, info]) => [
      name.toUpperCase(), info.allAttributes ?? info.attributes,
    ]));
    layouts.set(schema, layout);
  }
  return layout.get(type);
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

function slot(value: string, attribute?: Attribute, narrowAggregates = true): Slot {
  const members = narrowAggregates && (attribute?.isList || attribute?.isSet) ? listMembers(value) : null;
  return { value, members, optional: attribute?.optional ?? false, minimum: members ? attribute?.arrayBounds?.[0] ?? 1 : 1 };
}

function readSlots(rec: OutputRecord): Slot[] | undefined {
  const values = rec.frame ? splitTopLevelStepArguments(rec.raw) : null;
  const target = attributes('IFC4', rec.type);
  // Retained IFC2X3 records use their own optional slots. Check legacy
  // aggregates as whole slots because the pruning bounds are defined for IFC4.
  const layout = target ?? attributes('IFC2X3', rec.type);
  if (!values || !layout || values.length !== layout.length) return undefined;
  return values.map((value, index) => slot(value, layout[index], target !== undefined));
}

function indexRequiredMembers(rec: OutputRecord, users: Map<number, Member[]>): void {
  // Without a usable layout a lost reference makes the record unsafe to keep.
  for (const part of readSlots(rec) ?? [slot(rec.raw)]) {
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

function cascadeOmissions(records: Iterable<OutputRecord | undefined>, seeds: ReadonlySet<number>): Set<number> {
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

/** Evaluate the writer's required-reference cascade on the converted source layouts. */
export function previewUpgradeDependents(store: SourceStore, from: IfcSchemaVersion, to: IfcSchemaVersion): Set<number> {
  const seeds = new Set<number>();
  if (from !== 'IFC2X3' || to !== 'IFC4') return seeds;
  const source = new SourceRecords(store);
  for (const type of OMIT_ON_UPGRADE) for (const id of source.ids(type)) seeds.add(id);
  if (!seeds.size) return seeds;
  const sourceLayout = attrNameTable(from);
  const targetLayout = attrNameTable(to);
  function* projectedRecords(): Generator<OutputRecord | undefined> {
    for (const { id, text } of source.texts()) {
      if (seeds.has(id)) continue;
      const parsed = record(text);
      if (!parsed) continue;
      const route = missingTypeRoute(parsed.type, from, to, !!sourceLayout?.has(parsed.type),
        !!targetLayout?.has(convertEntityType(parsed.type, from, to)));
      if (route === 'unrepresented' && !isRootedEntityType(parsed.type)) continue;
      if (parsed.frame && splitTopLevelStepArguments(parsed.raw) !== null) {
        const converted = convertStepLine(text, from, to);
        if (converted !== null) yield converted === text ? parsed : record(converted);
      } else yield parsed;
    }
  }
  const dropped = cascadeOmissions(projectedRecords(), seeds);
  for (const id of seeds) dropped.delete(id);
  return dropped;
}

function rewrite(rec: OutputRecord, dropped: ReadonlySet<number>): string {
  if (!rec.frame || !referencesAnyExpressId(rec.raw, dropped)) return rec.line;
  const parts = readSlots(rec);
  if (!parts) return rec.line;
  const kept = parts.map(({ value, members, minimum }) => {
    if (!referencesAnyExpressId(value, dropped)) return value;
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
