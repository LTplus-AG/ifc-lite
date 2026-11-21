/* SPDX-License-Identifier: MPL-2.0 */

import { getSchemaRegistryForVersion } from '@ifc-lite/parser';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { frameArgs, stepRecordHead, stepRecordFrame, withFrameArgs, type StepRecordFrame } from './step-record-frame.js';
import { forEachExpressRef, referencesAnyExpressId } from './step-ref-scan.js';
import { isRootedEntityType, missingTypeRoute } from './schema-untranslatable.js';
import { convertEntityType, convertStepLine, type IfcSchemaVersion } from './schema-converter.js';
import { SourceRecords, type SourceStore } from './schema-converter-structural-source.js';
import { StyleFlatten } from './schema-style-flatten.js';
import { isStepValue, skipStepTrivia } from './step-slot-grammar.js';

type OutputRecord = { id: number; type: string; line: string; raw: string; frame: StepRecordFrame | null };
type Attribute = { optional: boolean; isList: boolean; isSet: boolean; arrayBounds?: readonly [number, number] };
type Slot = { value: string; optional: boolean; members: string[] | null; minimum: number };
type Group = { id: number; remaining: number; minimum: number };
type Member = { group: Group; lost: boolean };

type RegistrySchema = 'IFC2X3' | 'IFC4' | 'IFC4X3';
type UpgradeSchema = 'IFC4' | 'IFC4X3';

const layouts = new Map<RegistrySchema, Map<string, readonly Attribute[]>>();

function attributes(type: string, schema: RegistrySchema): readonly Attribute[] | undefined {
  let table = layouts.get(schema);
  if (!table) {
    table = new Map(Object.entries(getSchemaRegistryForVersion(schema).entities).map(([name, info]) => [
      name.toUpperCase(), info.allAttributes ?? info.attributes,
    ]));
    layouts.set(schema, table);
  }
  return table.get(type);
}

function removesObsoleteResources(from: IfcSchemaVersion, to: IfcSchemaVersion): boolean {
  return (from === 'IFC2X3' && (to === 'IFC4' || to === 'IFC4X3')) || (from === 'IFC4' && to === 'IFC4X3');
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

/** Collect direct omissions only from the source model that is being upgraded. */
export function noteUpgradeSeed(line: string, seeds: Set<number>, from: IfcSchemaVersion, to: IfcSchemaVersion): void {
  if (!removesObsoleteResources(from, to)) return;
  const head = stepRecordHead(line);
  if (!head) return;
  const type = line.slice(head.typeStart, head.typeEnd).toUpperCase();
  if (from === 'IFC5' || to === 'IFC5') return;
  const route = missingTypeRoute(type, from, to, attributes(type, from) !== undefined, attributes(type, to) !== undefined);
  if (route !== 'omitted') return;
  const id = recordId(line);
  if (id <= 0xffffffff) seeds.add(id);
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

function readSlots(rec: OutputRecord, to: UpgradeSchema): Slot[] {
  const values = rec.frame ? splitTopLevelStepArguments(rec.raw) : null;
  const layout = attributes(rec.type, to);
  // If the target layout cannot be established, the record is only safe when
  // none of its references is lost. Treat the entire argument list as required.
  if (!values || !layout || values.length !== layout.length) return [slot(rec.raw)];
  return values.map((value, index) => slot(value, layout[index]));
}

function indexRequiredMembers(rec: OutputRecord, users: Map<number, Member[]>, to: UpgradeSchema): void {
  for (const part of readSlots(rec, to)) {
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

function cascadeOmissions(records: Iterable<OutputRecord | undefined>, seeds: ReadonlySet<number>, to: UpgradeSchema): Set<number> {
  const dropped = new Set(seeds);
  const users = new Map<number, Member[]>();
  for (const rec of records) {
    if (rec && !dropped.has(rec.id)) indexRequiredMembers(rec, users, to);
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

/** Preview required-reference losses on the target layouts of an unedited source. */
export function previewUpgradeDependents(store: SourceStore, from: IfcSchemaVersion, to: IfcSchemaVersion): Set<number> {
  const seeds = new Set<number>();
  if (!removesObsoleteResources(from, to) || from === 'IFC5' || (to !== 'IFC4' && to !== 'IFC4X3')) return seeds;
  const routeOf = (type: string) => missingTypeRoute(type, from, to, attributes(type, from) !== undefined,
    attributes(convertEntityType(type, from, to), to) !== undefined);
  // @raw-entity-enumeration-ok the preview describes only the unedited parsed source
  for (const [type, ids] of store.entityIndex.byType) {
    if (routeOf(type.toUpperCase()) === 'omitted') for (const id of ids) seeds.add(id);
  }
  if (seeds.size === 0) return seeds;

  const styles = StyleFlatten.fromStore(store, from, to);
  const source = new SourceRecords(store);
  function* projectedRecords(): Generator<OutputRecord | undefined> {
    // @raw-entity-enumeration-ok this reads the unedited parsed source once after finding direct omissions
    for (const id of store.entityIndex.byId.keys()) {
      if (seeds.has(id)) continue;
      const text = source.text(id);
      if (text === undefined) continue;
      const line = styles ? styles.apply(text) : text;
      if (line === null) continue;
      const parsed = record(line);
      if (!parsed || (routeOf(parsed.type) === 'unrepresented' && !isRootedEntityType(parsed.type))) continue;
      // The report can still describe other losses when a malformed record would abort the export.
      if (parsed.frame && splitTopLevelStepArguments(parsed.raw) !== null) {
        const converted = convertStepLine(line, from, to);
        if (converted !== null) yield converted === line ? parsed : record(converted);
      } else yield parsed;
    }
  }
  const dropped = cascadeOmissions(projectedRecords(), seeds, to);
  for (const id of seeds) dropped.delete(id);
  return dropped;
}

function rewrite(rec: OutputRecord, dropped: ReadonlySet<number>, to: UpgradeSchema): string {
  if (!rec.frame || !referencesAnyExpressId(rec.raw, dropped)) return rec.line;
  const layout = attributes(rec.type, to);
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
export function pruneUpgrade(lines: string[], seeds: ReadonlySet<number>, to: IfcSchemaVersion): string[] {
  if (seeds.size === 0 || (to !== 'IFC4' && to !== 'IFC4X3')) return [];
  const records = lines.map(record);
  const dropped = cascadeOmissions(records, seeds, to);
  const warnings: string[] = [];
  let next = 0;
  for (const [index, rec] of records.entries()) {
    if (rec && dropped.has(rec.id)) {
      const reason = seeds.has(rec.id) ? `the ${to} schema does not declare its type` : `a required ${to} attribute lost a reference`;
      warnings.push(`#${rec.id} (${rec.type}) was omitted because ${reason} (#${to === 'IFC4' ? 10970 : 10971}).`);
    } else {
      lines[next++] = rec ? rewrite(rec, dropped, to) : lines[index];
    }
  }
  lines.length = next;
  return warnings;
}


/** Single-model output contains only converted records, including pending edits. */
export function pruneUpgradeFromSource(lines: string[], from: IfcSchemaVersion, to: IfcSchemaVersion): string[] {
  if (!removesObsoleteResources(from, to)) return [];
  const seeds = new Set<number>();
  for (const line of lines) noteUpgradeSeed(line, seeds, from, to);
  return pruneUpgrade(lines, seeds, to);
}
