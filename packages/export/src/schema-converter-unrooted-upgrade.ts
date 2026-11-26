/* SPDX-License-Identifier: MPL-2.0 */

import { getSchemaRegistryForVersion } from '@ifc-lite/parser';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { frameArgs, stepRecordHead, stepRecordFrame, withFrameArgs, type StepRecordFrame } from './step-record-frame.js';
import { forEachExpressRef, referencesAnyExpressId } from './step-ref-scan.js';
import { isRootedEntityType, missingTypeRoute, VERBATIM_UPGRADE } from './schema-untranslatable.js';
import { varyingTarget } from './schema-converter-structural-varying.js';
import { convertEntityType, convertStepLine, type IfcSchemaVersion } from './schema-converter.js';
import { EnumReconciliation } from './schema-converter-enums.js';
import { getCompleteEntityIndex, getMaxExpressId } from './entity-iteration.js';
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

export function removesObsoleteResources(from: IfcSchemaVersion, to: IfcSchemaVersion): boolean {
  return (from === 'IFC2X3' && (to === 'IFC4' || to === 'IFC4X3')) || (from === 'IFC4' && to === 'IFC4X3');
}

/** Written STEP ids include safe-integer merge offsets; source indexes remain u32. */
export function outputRecordId(line: string): number {
  const start = skipStepTrivia(line, 0);
  return Number(/^#(\d+)/.exec(line.slice(start))?.[1]);
}

function record(line: string): OutputRecord | undefined {
  const head = stepRecordHead(line);
  if (head === null) return undefined;
  const id = outputRecordId(line);
  if (!Number.isSafeInteger(id)) return undefined;
  const type = line.slice(head.typeStart, head.typeEnd).toUpperCase();
  const frame = stepRecordFrame(line);
  const raw = frame ? frameArgs(line, frame) : line.slice(head.open + 1);
  return { id, type, line, raw, frame };
}

/** Collect direct omissions only from the source model that is being upgraded. */
function noteUpgradeSeed(line: string, seeds: Set<number>, from: IfcSchemaVersion, to: IfcSchemaVersion): void {
  if (!removesObsoleteResources(from, to)) return;
  const head = stepRecordHead(line);
  if (!head) return;
  const type = line.slice(head.typeStart, head.typeEnd).toUpperCase();
  if (from === 'IFC5' || to === 'IFC5') return;
  const route = missingTypeRoute(type, from, to, attributes(type, from) !== undefined, attributes(type, to) !== undefined);
  if (route !== 'omitted') return;
  const id = outputRecordId(line);
  if (Number.isSafeInteger(id)) seeds.add(id);
}

function listMembers(value: string): string[] | null {
  const open = skipStepTrivia(value, 0);
  if (value[open] !== '(' || !isStepValue(value, Number.MAX_SAFE_INTEGER)) return null;
  // isStepValue verifies that the outer list is followed only by STEP trivia.
  // Look past its comments before choosing the closing parenthesis.
  let end = value.length;
  while (end > open) {
    const close = value.lastIndexOf(')', end - 1);
    if (close <= open) return null;
    if (skipStepTrivia(value, close + 1) === value.length) {
      const items = splitTopLevelStepArguments(value.slice(open + 1, close), Number.MAX_SAFE_INTEGER);
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

function readSlots(rec: OutputRecord, to: UpgradeSchema): Slot[] | undefined {
  const values = rec.frame ? splitTopLevelStepArguments(rec.raw, Number.MAX_SAFE_INTEGER) : null;
  const target = attributes(rec.type, to);
  // Verbatim records and varying actions left unconverted in IFC4 keep their
  // IFC2X3 optional slots. Check their aggregates as whole slots.
  const retainedLegacy = target === undefined
    && (VERBATIM_UPGRADE.has(rec.type) || (to === 'IFC4' && varyingTarget(rec.type) !== undefined));
  const layout = target ?? (retainedLegacy ? attributes(rec.type, 'IFC2X3') : undefined);
  if (!values || !layout || values.length !== layout.length) return undefined;
  // Sectioned-spine sections and positions correspond by index. Withhold on any loss.
  const narrow = target !== undefined && rec.type !== 'IFCSECTIONEDSPINE';
  return values.map((value, index) => slot(value, layout[index], narrow));
}

function indexRequiredMembers(rec: OutputRecord, users: Map<number, Member[]>, to: UpgradeSchema): void {
  // Without a usable layout a lost reference makes the record unsafe to keep.
  for (const part of readSlots(rec, to) ?? [slot(rec.raw)]) {
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
  const source = new SourceRecords(store);
  // @raw-entity-enumeration-ok enumerate the kinds in the unedited parsed source; SourceRecords supplies the kept IDs
  for (const type of store.entityIndex.byType.keys()) {
    if (routeOf(type.toUpperCase()) === 'omitted') for (const id of source.ids(type)) seeds.add(id);
  }
  if (seeds.size === 0) return seeds;

  const styles = StyleFlatten.fromStore(store, from, to);
  const enums = new EnumReconciliation(true, [store]);
  enums.structural.fromStore(store, from, to, source);
  let nextId = getMaxExpressId(getCompleteEntityIndex(store)) + 1;
  enums.structural.ids = () => nextId++;
  function* projectedRecords(): Generator<OutputRecord | undefined> {
    for (const { id, text } of source.texts()) {
      if (seeds.has(id)) continue;
      const line = styles ? styles.apply(text) : text;
      if (line === null) continue;
      const parsed = record(line);
      if (!parsed || (routeOf(parsed.type) === 'unrepresented' && !isRootedEntityType(parsed.type))) continue;
      // The report can still describe other losses when a malformed record would abort the export.
      if (parsed.frame && splitTopLevelStepArguments(parsed.raw) !== null) {
        const converted = convertStepLine(line, from, to, undefined, undefined, undefined, undefined, enums);
        if (converted !== null) yield converted === line ? parsed : record(converted);
      } else yield parsed;
    }
    yield* enums.structural.added().map(record);
  }
  const dropped = cascadeOmissions(projectedRecords(), seeds, to);
  for (const id of seeds) dropped.delete(id);
  return dropped;
}

function rewrite(rec: OutputRecord, dropped: ReadonlySet<number>, to: UpgradeSchema): string {
  if (!rec.frame || !referencesAnyExpressId(rec.raw, dropped)) return rec.line;
  const parts = readSlots(rec, to);
  if (!parts) return rec.line;
  const kept = parts.map(({ value, members, minimum }) => {
    if (!referencesAnyExpressId(value, dropped)) return value;
    const filtered = members?.filter((member) => !referencesAnyExpressId(member, dropped));
    return filtered && filtered.length >= minimum ? `(${filtered.join(',')})` : '$';
  });
  return withFrameArgs(rec.line, rec.frame, kept.join(','));
}

/** Run after conversion so every reference is in the final id space and slot. */
function pruneUpgrade(lines: string[], seeds: ReadonlySet<number>, to: IfcSchemaVersion, onOmitted?: (id: number) => void): string[] {
  if (seeds.size === 0 || (to !== 'IFC4' && to !== 'IFC4X3')) return [];
  const records = lines.map(record);
  const dropped = cascadeOmissions(records, seeds, to);
  const warnings: string[] = [];
  let next = 0;
  for (const [index, rec] of records.entries()) {
    if (rec && dropped.has(rec.id)) {
      onOmitted?.(rec.id);
      const reason = seeds.has(rec.id) ? `the ${to} schema does not declare its type` : `a required ${to} attribute lost a reference`;
      warnings.push(`#${rec.id} (${rec.type}) was omitted because ${reason} (#${to === 'IFC4' ? 10970 : 10971}).`);
    } else {
      lines[next++] = rec ? rewrite(rec, dropped, to) : lines[index];
    }
  }
  lines.length = next;
  return warnings;
}

/** Keep records that will be omitted out of the next model's GlobalId reconciliation. */
export class MergedUpgradePruning {
  private readonly seeds = new Set<number>();
  private omitted = new Set<number>();

  constructor(private readonly target: IfcSchemaVersion) {}

  note(line: string, from: IfcSchemaVersion): void {
    noteUpgradeSeed(line, this.seeds, from, this.target);
  }

  /**
   * Release the GlobalIds of unifiable records the final prune will omit. A relationship is never unified, and a
   * later model's fold can still keep one omitted here, so its GlobalId stays reserved: at worst a later relationship
   * with the same GlobalId is re-stamped.
   */
  forgetOmittedGuids<T extends { finalId: number; canUnify: boolean }>(lines: string[], start: number, guids: Map<string, T>): void {
    if (!this.seeds.size || (this.target !== 'IFC4' && this.target !== 'IFC4X3')) return;
    const previousCount = this.omitted.size;
    for (const id of this.seeds) this.omitted.add(id);
    // Model offsets keep emitted ids disjoint. Remaps can refer back to an
    // earlier model, so index this model with the omissions already known.
    this.omitted = cascadeOmissions(lines.slice(start).map(record), this.omitted, this.target);
    if (this.omitted.size > previousCount) {
      for (const [guid, record] of guids) if (record.canUnify && this.omitted.has(record.finalId)) guids.delete(guid);
    }
  }

  finish(lines: string[]): string[] {
    return pruneUpgrade(lines, this.seeds, this.target);
  }
}

/** Single-model output contains only converted records, including pending edits. */
export function pruneUpgradeFromSource(lines: string[], from: IfcSchemaVersion, to: IfcSchemaVersion, onOmitted: (id: number) => void): string[] {
  if (!removesObsoleteResources(from, to)) return [];
  const seeds = new Set<number>();
  for (const line of lines) noteUpgradeSeed(line, seeds, from, to);
  return pruneUpgrade(lines, seeds, to, onOmitted);
}
