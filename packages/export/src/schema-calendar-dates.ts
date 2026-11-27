/* SPDX-License-Identifier: MPL-2.0 */

import {
  DATE_CARRIERS, fromLegacyDate, toLegacyDate, type CalendarKind, type DateRecord,
} from './schema-calendar-date-values.js';
import { readStepSlots } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';
import { namedExpressIds } from './step-ref-scan.js';
import { slotRef, SourceRecords, type SourceStore } from './schema-converter-structural-source.js';
import { attrNameTable, convertEntityType, convertStepLine } from './schema-converter.js';
import { rulesFor } from './schema-converter-value-forms.js';
import { missingTypeRoute } from './schema-untranslatable.js';
import { MAX_SOURCE_STEP_ID, skipStepTrivia } from './step-slot-grammar.js';

/** What a deferred date slot lost: all of it, its time (kept the date), or nothing but a clock precision it filled (#11199). */
export type DateLoss = 'dropped' | 'narrowed' | 'filled';

interface PendingDate { slot: number; kind: CalendarKind; up: boolean; lost: (loss: DateLoss) => void }

function recordId(text: string): number {
  const match = /^#(\d+)/.exec(text.slice(skipStepTrivia(text, 0)));
  return match ? Number(match[1]) : 0;
}

/** Date form changes need the effective file's own references or fresh ids. */
export class CalendarDates {
  private readonly pending = new Map<number, PendingDate[]>();
  private retained = 0;
  /** Each legacy date record neither successfully converted nor retained (#11199). */
  private readonly omitted: [id: number, type: string][] = [];
  /** An IFC2X3 upgrade wrote a legacy date record, so those nothing references go even when no slot converts (#11199). */
  private carriersWritten = false;
  /** The upgrade's target, whose omitted-route records reference nothing once written (#11199). */
  private target: 'IFC4' | 'IFC4X3' = 'IFC4';

  constructor(private readonly enabled: boolean) {}

  /** Note an IFC2X3 upgrade's record of `type`: a legacy date record arms the finishing pass. */
  noteUpgraded(type: string, to: 'IFC4' | 'IFC4X3'): void {
    this.target = to;
    if (DATE_CARRIERS.has(type)) this.carriersWritten = true;
  }

  defer(text: string, slot: number, operator: string, lost: (loss: DateLoss) => void): boolean {
    if (!this.enabled) return false;
    const id = recordId(text);
    if (!id) return false;
    const date = { slot, kind: operator.slice(3) as CalendarKind, up: operator[1] === '+', lost };
    const records = this.pending.get(id);
    if (records) records.push(date);
    else this.pending.set(id, [date]);
    return true;
  }

  finish(lines: string[], maxReferenceId = MAX_SOURCE_STEP_ID): void {
    if (!this.enabled || (!this.pending.size && !this.carriersWritten)) return;
    const upgrade = this.carriersWritten || [...this.pending.values()].some((rules) => rules.some((rule) => rule.up));
    const carriers = new Map<number, DateRecord>();
    let next = 1;
    for (const line of lines) {
      const id = recordId(line);
      next = Math.max(next, id + 1);
      const head = upgrade ? stepRecordHead(line) : null;
      if (!head) continue;
      const type = line.slice(head.typeStart, head.typeEnd).toUpperCase();
      if (!DATE_CARRIERS.has(type)) continue;
      const record = readStepSlots(line, maxReferenceId);
      if (record) carriers.set(id, record);
    }
    // For loss accounting keep successful conversion inputs and surviving refs.
    // A failed conversion contributes neither, even when the source slot held a ref.
    const accounted = new Map<number, string>();
    const added: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const dates = this.pending.get(recordId(lines[index]));
      if (!dates) continue;
      const record = readStepSlots(lines[index], maxReferenceId);
      if (!record) continue;
      const slots = [...record.slots];
      let accountingSlots: string[] | undefined;
      for (const date of dates) {
        const value = slots[date.slot];
        let fixed: string | null;
        let narrowed = false, filled = false;
        if (date.up) {
          const result = fromLegacyDate(value, date.kind, (id) => id === null ? undefined : carriers.get(id));
          fixed = result?.value ?? null;
          if (!result) (accountingSlots ??= [...record.slots])[date.slot] = '$';
          narrowed = result?.narrowed ?? false;
          filled = result?.filled ?? false;
        } else {
          let candidate = next;
          const result = toLegacyDate(value, date.kind, () => candidate++);
          if (result && result.records.length - 1 <= maxReferenceId - next) {
            added.push(...result.records);
            next = candidate;
            fixed = result.ref;
          } else fixed = null;
        }
        if (fixed === null || narrowed || filled) date.lost(fixed === null ? 'dropped' : narrowed ? 'narrowed' : 'filled');
        slots[date.slot] = fixed ?? '$';
      }
      if (upgrade) accounted.set(recordId(lines[index]), accountingSlots
        ? record.prefix + accountingSlots.join(',') + record.suffix : lines[index]);
      lines[index] = record.prefix + slots.join(',') + record.suffix;
    }
    this.pending.clear();
    if (carriers.size) {
      const reached = carrierUse(carrierReferrers(lines, this.target, accounted), carriers);
      for (const [id, record] of carriers) if (!reached.has(id)) this.omitted.push([id, record.type]);
      const used = carrierUse(carrierReferrers(lines, this.target), carriers);
      this.retained = used.size;
      let kept = 0;
      for (const line of lines) {
        const id = recordId(line);
        if (!carriers.has(id) || used.has(id)) lines[kept++] = line;
      }
      lines.length = kept;
    }
    for (const line of added) lines.push(line);
  }

  warnings(): string[] {
    return [
      ...(this.retained ? [this.retained + ' legacy IFC2X3 date record(s) are still referenced by unconverted slots, so the file is not valid against its header (#10879).'] : []),
      ...(this.omitted.length ? [`${this.omitted.length} legacy IFC2X3 date record(s) were omitted because no written record references them and the target schema does not declare their type: ${
        [...this.omitted].sort(([a], [b]) => a - b).map(([id, type]) => `#${id} (${type})`).join(', ')} (#11199).`] : []),
    ];
  }
}

/** Why an IFC2X3 upgrade leaves out a legacy date record nothing references (#11199). */
export const ORPHAN_DATE = 'no written record references it and the target schema does not declare its type (#11199)';

/** Whether the IFC2X3 upgrade to `to` writes a record of `type` with its references: not one it proxies or omits.
 *  `convertRecord`'s own route decides (#11199). */
function writesReferences(type: string, to: 'IFC4' | 'IFC4X3', converted: boolean): boolean {
  const [source, target] = [attrNameTable('IFC2X3'), attrNameTable(to)];
  const written = converted ? type : convertEntityType(type, 'IFC2X3', to);
  return DATE_CARRIERS.has(type) || !['unrepresented', 'omitted'].includes(
    missingTypeRoute(type, 'IFC2X3', to, source?.has(type) ?? false, !target || target.has(written)));
}

/** The output lines of an IFC2X3 upgrade to `to` whose references survive the upgrade prune. */
function* carrierReferrers(lines: readonly string[], to: 'IFC4' | 'IFC4X3', accounted?: ReadonlyMap<number, string>): Generator<string> {
  for (const line of lines) {
    const head = stepRecordHead(line);
    if (!head || writesReferences(line.slice(head.typeStart, head.typeEnd).toUpperCase(), to, true)) yield accounted?.get(recordId(line)) ?? line;
  }
}

/** The carriers some other record reaches, directly or through another carrier. */
function carrierUse(lines: Iterable<string>, carriers: ReadonlyMap<number, { slots: readonly string[] }>): Set<number> {
  const targets = new Set(carriers.keys());
  const used = new Set<number>();
  for (const line of lines) {
    if (carriers.has(recordId(line))) continue;
    const header = stepRecordHead(line);
    for (const id of namedExpressIds(line.slice(header?.open ?? 0), targets)) used.add(id);
  }
  // Set iteration visits additions at the end. Each date component is read once.
  for (const id of used) {
    const record = carriers.get(id);
    if (!record) continue;
    for (const slot of record.slots) for (const ref of namedExpressIds(slot, targets)) used.add(ref);
  }
  return used;
}

/** The legacy date records of an unedited IFC2X3 source that an upgrade to `to` leaves out, for the loss report (#11199). */
export function orphanDateRecords(store: SourceStore, from: string, to: 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5'): Set<number> {
  if (from !== 'IFC2X3' || (to !== 'IFC4' && to !== 'IFC4X3')) return new Set();
  const source = new SourceRecords(store);
  const carriers = new Map<number, DateRecord>();
  for (const type of DATE_CARRIERS) for (const id of source.ids(type)) carriers.set(id, { type, slots: source.slots(id) ?? [] });
  if (!carriers.size) return new Set();
  const targets = new Set(carriers.keys());
  // A referrer the writer proxies or omits does not write its date references, as in the export.
  const written = function* () {
    for (const { id, text } of source.texts()) {
      if (carriers.has(id) || !namedExpressIds(text.slice(stepRecordHead(text)?.open ?? 0), targets).size) continue;
      const type = source.type(id);
      if (!type || !writesReferences(type, to, false)) continue;
      const { arity, rules } = rulesFor(from, to, convertEntityType(type, 'IFC2X3', to));
      if (!rules.some(rule => rule.hasCalendar)) { yield text; continue; }
      // Calendar rules address the writer's target slots, including remapped attributes.
      const converted = convertStepLine(text, 'IFC2X3', to);
      if (!converted) continue;
      const record = readStepSlots(converted);
      if (!record || record.slots.length !== arity) { yield converted; continue; }
      const slots = [...record.slots];
      for (const rule of rules) {
        const operator = rule.forms.get('#');
        const slot = slots[rule.index];
        if (operator?.startsWith('C+:') && slotRef(slot) !== null &&
            !fromLegacyDate(slot, operator.slice(3) as CalendarKind, id => id === null ? undefined : carriers.get(id))) slots[rule.index] = '$';
      }
      yield record.prefix + slots.join(',') + record.suffix;
    }
  };
  const used = carrierUse(written(), carriers);
  return new Set([...carriers.keys()].filter((id) => !used.has(id)));
}
