/* SPDX-License-Identifier: MPL-2.0 */

import {
  DATE_CARRIERS, fromLegacyDate, toLegacyDate, type CalendarKind, type DateRecord,
} from './schema-calendar-date-values.js';
import { readStepSlots } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';
import { namedExpressIds } from './step-ref-scan.js';
import { SourceRecords, type SourceStore } from './schema-converter-structural-source.js';
import { attrNameTable, convertEntityType } from './schema-converter.js';
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
  /** Each legacy date record no written record reached before slots converted, so it was left out (#11199). */
  private readonly omitted: [id: number, type: string][] = [];
  /** An IFC2X3 upgrade wrote a legacy date record, so those nothing references go even when no slot converts (#11199). */
  private carriersWritten = false;

  constructor(private readonly enabled: boolean) {}

  /** Note an IFC2X3 upgrade's record of `type`: a legacy date record arms the finishing pass. */
  noteUpgraded(type: string): void {
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
    // What no written record reaches before slots convert carries no value anywhere: it is omitted, and named (#11199).
    const reached = carriers.size ? carrierUse(lines, carriers) : new Set<number>();
    const added: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const dates = this.pending.get(recordId(lines[index]));
      if (!dates) continue;
      const record = readStepSlots(lines[index], maxReferenceId);
      if (!record) continue;
      const slots = [...record.slots];
      for (const date of dates) {
        const value = slots[date.slot];
        let fixed: string | null;
        let narrowed = false, filled = false;
        if (date.up) {
          const result = fromLegacyDate(value, date.kind, (id) => id === null ? undefined : carriers.get(id));
          fixed = result?.value ?? null;
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
      lines[index] = record.prefix + slots.join(',') + record.suffix;
    }
    this.pending.clear();
    if (carriers.size) {
      for (const [id, record] of carriers) if (!reached.has(id)) this.omitted.push([id, record.type]);
      const used = carrierUse(lines, carriers);
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
  const carriers = new Map<number, { slots: readonly string[] }>();
  for (const type of DATE_CARRIERS) for (const id of source.ids(type)) carriers.set(id, { slots: source.slots(id) ?? [] });
  if (!carriers.size) return new Set();
  // A referrer the writer proxies or omits does not write its date references; `convertRecord`'s own route decides.
  const [sourceTable, target] = [attrNameTable(from), attrNameTable(to)];
  const writesRefs = (type: string) => !['unrepresented', 'omitted'].includes(
    missingTypeRoute(type, from, to, sourceTable?.has(type) ?? false, !target || target.has(convertEntityType(type, from, to))));
  const written = function* () {
    for (const { id, text } of source.texts()) {
      const type = source.type(id);
      if (type && (carriers.has(id) || writesRefs(type))) yield text;
    }
  };
  const used = carrierUse(written(), carriers);
  return new Set([...carriers.keys()].filter((id) => !used.has(id)));
}
