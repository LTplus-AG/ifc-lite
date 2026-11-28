/* SPDX-License-Identifier: MPL-2.0 */
import { readStepSlots } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';
import { slotRef, type SourceStore } from './schema-converter-structural-source.js';
import { durationFromSeconds, durationToSeconds } from './schema-converter-durations.js';
import { sourceTimeScale, writtenTimeScale } from './schema-project-time-unit.js';
import { toStepReal } from './step-serialization.js';

type Model = { source: SourceStore; projects: readonly number[] };
type Conversion = { index: number; up: boolean; model?: Model };
export class WorkControlDurations {
  private readonly pending = new Map<number, Conversion[]>();
  private unresolved = false;
  private overflow = false;
  upgradeScale?: () => number | undefined;
  private model?: Model;

  beginModel(source: SourceStore, projects: readonly number[], remap: ReadonlyMap<number, number>, offset: number, written: (id: number) => boolean): void {
    // Folded projects use the primary id. Retained projects use their emitted id.
    const owners = projects.filter(id => remap.has(id) || written(id)).map(id => remap.get(id) ?? id + offset);
    this.model = { source, projects: owners };
  }

  capture(id: number, index: number, up: boolean): void {
    const slots = this.pending.get(id) ?? [];
    slots.push({ index, up, model: this.model });
    this.pending.set(id, slots);
  }

  finish(lines: string[], bound = 0xffffffff): void {
    if (!this.pending.size) return;
    const downgrade = Array.from(this.pending.values()).some(slots => slots.some(slot => !slot.up));
    const written = downgrade ? writtenTimeScale(lines, bound) : undefined;
    const scales = new Map<Model | undefined, number | undefined>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], head = stepRecordHead(line);
      const id = head && slotRef(line.slice(0, head.eq));
      const pending = id != null && this.pending.get(id);
      if (!pending) continue;
      const record = readStepSlots(line, bound);
      if (!record) continue;
      const slots = [...record.slots];
      for (const {index, up, model} of pending) {
        if (!scales.has(model)) {
          const factor = up ? (model ? sourceTimeScale(model.source) : this.upgradeScale?.()) : written?.(model?.projects);
          scales.set(model, factor);
        }
        const factor = scales.get(model);
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
