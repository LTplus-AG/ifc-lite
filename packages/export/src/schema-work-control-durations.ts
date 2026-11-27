/* SPDX-License-Identifier: MPL-2.0 */
import { readStepSlots } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';
import { slotRef, type SourceStore } from './schema-converter-structural-source.js';
import { durationFromSeconds, durationToSeconds } from './schema-converter-durations.js';
import { sourceTimeScale, writtenTimeScale } from './schema-project-time-unit.js';
import { toStepReal } from './step-serialization.js';

type Conversion = { index: number; up: boolean; source?: SourceStore };
export class WorkControlDurations {
  private readonly pending = new Map<number, Conversion[]>();
  private readonly sourceScales = new Map<SourceStore, number | undefined>();
  private unresolved = false;
  private overflow = false;
  upgradeScale?: () => number | undefined;
  mergedSource?: SourceStore;

  capture(id: number, index: number, up: boolean): void {
    const slots = this.pending.get(id) ?? [];
    slots.push({ index, up, source: up ? this.mergedSource : undefined });
    this.pending.set(id, slots);
  }

  finish(lines: string[], bound = 0xffffffff): void {
    if (!this.pending.size) return;
    const downgrade = Array.from(this.pending.values()).some(slots => slots.some(slot => !slot.up));
    const effective = downgrade ? writtenTimeScale(lines, bound) : this.upgradeScale?.();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], head = stepRecordHead(line);
      const id = head && slotRef(line.slice(0, head.eq));
      const pending = id != null && this.pending.get(id);
      if (!pending) continue;
      const record = readStepSlots(line, bound);
      if (!record) continue;
      const slots = [...record.slots];
      for (const {index, up, source} of pending) {
        if (source && !this.sourceScales.has(source)) this.sourceScales.set(source, sourceTimeScale(source));
        const factor = source ? this.sourceScales.get(source) : effective;
        if (factor === undefined) { this.unresolved = true; continue; }
        if (factor === 1) continue;
        const seconds = up ? durationToSeconds(slots[index]) : slots[index];
        if (seconds === null) continue;
        const value = up ? Number(seconds) * factor : Number(seconds) / factor;
        if (!Number.isFinite(value)) { slots[index] = '$'; this.overflow = true; continue; }
        slots[index] = up ? durationFromSeconds(toStepReal(value))! : toStepReal(value);
      }
      lines[i] = record.prefix + slots.join(',') + record.suffix;
    }
    this.pending.clear();
  }

  warnings(): string[] {
    return [
      ...(this.unresolved ? ['Work-control duration conversion assumed seconds because the applicable project TIMEUNIT was unresolved or conflicting (#11192).'] : []),
      ...(this.overflow ? ['A work-control duration or total float overflowed during project TIMEUNIT conversion and was omitted (#11192).'] : []),
    ];
  }
}
