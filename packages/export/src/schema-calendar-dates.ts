/* SPDX-License-Identifier: MPL-2.0 */

import {
  DATE_CARRIERS, fromLegacyDate, toLegacyDate, type CalendarKind, type DateRecord,
} from './schema-calendar-date-values.js';
import { readStepSlots } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';
import { namedExpressIds } from './step-ref-scan.js';
import { skipStepTrivia } from './step-slot-grammar.js';

interface PendingDate { slot: number; kind: CalendarKind; up: boolean; lost: () => void }

function recordId(text: string): number {
  const match = /^#(\d+)/.exec(text.slice(skipStepTrivia(text, 0)));
  return match ? Number(match[1]) : 0;
}

/** Date form changes need the effective file's own references or fresh ids. */
export class CalendarDates {
  private readonly pending = new Map<number, PendingDate[]>();
  private retained = 0;

  constructor(private readonly enabled: boolean) {}

  defer(text: string, slot: number, operator: string, lost: () => void): boolean {
    if (!this.enabled) return false;
    const id = recordId(text);
    if (!id) return false;
    const date = { slot, kind: operator.slice(3) as CalendarKind, up: operator[1] === '+', lost };
    const records = this.pending.get(id);
    if (records) records.push(date);
    else this.pending.set(id, [date]);
    return true;
  }

  finish(lines: string[]): void {
    if (!this.pending.size) return;
    const upgrade = [...this.pending.values()].some((rules) => rules.some((rule) => rule.up));
    const carriers = new Map<number, DateRecord>();
    let next = 1;
    for (const line of lines) {
      const id = recordId(line);
      next = Math.max(next, id + 1);
      const head = upgrade ? stepRecordHead(line) : null;
      if (!head) continue;
      const type = line.slice(head.typeStart, head.typeEnd).toUpperCase();
      if (!DATE_CARRIERS.has(type)) continue;
      const record = readStepSlots(line);
      if (record) carriers.set(id, record);
    }
    const added: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      const dates = this.pending.get(recordId(lines[index]));
      if (!dates) continue;
      const record = readStepSlots(lines[index]);
      if (!record) continue;
      const slots = [...record.slots];
      for (const date of dates) {
        const value = slots[date.slot];
        let fixed: string | null;
        if (date.up) fixed = fromLegacyDate(value, date.kind, (id) => id === null ? undefined : carriers.get(id));
        else {
          let candidate = next;
          const result = toLegacyDate(value, date.kind, () => candidate++);
          if (result && candidate - 1 <= 0xffffffff) {
            added.push(...result.records);
            next = candidate;
            fixed = result.ref;
          } else fixed = null;
        }
        if (fixed === null) date.lost();
        slots[date.slot] = fixed ?? '$';
      }
      lines[index] = record.prefix + slots.join(',') + record.suffix;
    }
    this.pending.clear();
    if (carriers.size) this.retained = pruneCarriers(lines, carriers);
    for (const line of added) lines.push(line);
  }

  warnings(): string[] {
    return this.retained
      ? [this.retained + ' legacy IFC2X3 date record(s) are still referenced by unconverted slots, so the file is not valid against its header (#10879).']
      : [];
  }
}

function pruneCarriers(lines: string[], carriers: ReadonlyMap<number, DateRecord>): number {
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
  let kept = 0;
  for (const line of lines) {
    const id = recordId(line);
    if (!carriers.has(id) || used.has(id)) lines[kept++] = line;
  }
  lines.length = kept;
  return used.size;
}
