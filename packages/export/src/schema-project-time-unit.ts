/* SPDX-License-Identifier: MPL-2.0 */
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { EffectiveEntityIndex } from './effective-index.js';
import { effectiveCreatedRecord, effectiveSourceRecord } from './effective-source-record.js';
import { SI_PREFIX_MULTIPLIERS } from '@ifc-lite/parser';
import { listItems } from './schema-converter-structural-axes.js';
import { slotRef, SourceRecords, type SourceStore } from './schema-converter-structural-source.js';
import { withoutComments } from './step-comment-skip.js';
import { parseStepNumber } from './step-slot-grammar.js';
import { readStepSlots } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';

import { validLegacyConversionFactor } from './declared-property-type.js';

type Records = Pick<SourceRecords, 'slots' | 'type'>;
const token = (value: string | undefined) => withoutComments(value ?? '').trim().toUpperCase();

function secondsPerUnit(records: Records, id: number | null): number | undefined {
  const visited = new Set<number>();
  let scale = 1;
  while (id !== null && !visited.has(id)) {
    visited.add(id);
    const slots = records.slots(id);
    if (!slots || token(slots[1]) !== '.TIMEUNIT.') return undefined;
    const type = records.type(id);
    if (type === 'IFCSIUNIT' && token(slots[3]) === '.SECOND.') {
      const prefix = token(slots[2]);
      const multiplier = prefix === '$' ? 1 : SI_PREFIX_MULTIPLIERS[/^\.(\w+)\.$/.exec(prefix)?.[1] ?? ''];
      const factor = scale * multiplier;
      return Number.isFinite(factor) && factor > 0 ? factor : undefined;
    }
    if (type !== 'IFCCONVERSIONBASEDUNIT') return undefined;
    const measure = slotRef(slots[3]);
    if (records.type(measure) !== 'IFCMEASUREWITHUNIT') return undefined;
    const component = records.slots(measure);
    const value = /^(IFC[A-Z0-9]+)\s*\(([^()]*)\)$/.exec(token(component?.[0]));
    if (!value) return undefined;
    const literal = value[2].trim();
    const factor = parseStepNumber(literal);
    if (!validLegacyConversionFactor(value[1], literal, factor)) return undefined;
    scale *= factor;
    id = slotRef(component?.[1]);
  }
  return undefined;
}

function resolve(projects: readonly number[], records: Records): number | undefined {
  let scale: number | undefined;
  for (const project of projects) {
    if (records.type(project) !== 'IFCPROJECT') return undefined;
    const assignment = slotRef(records.slots(project)?.[8]);
    if (records.type(assignment) !== 'IFCUNITASSIGNMENT') return undefined;
    let found = false;
    for (const ref of listItems(records.slots(assignment)?.[0] ?? '') ?? []) {
      const id = slotRef(ref);
      if (!records.type(id)) return undefined;
      if (token(records.slots(id)?.[1]) !== '.TIMEUNIT.') continue;
      const factor = secondsPerUnit(records, id);
      if (factor === undefined || (scale !== undefined && scale !== factor)) return undefined;
      scale = factor;
      found = true;
    }
    if (!found) return undefined;
  }
  return scale;
}

export function sourceTimeScale(store: SourceStore): number | undefined {
  const records = new SourceRecords(store);
  return resolve(records.ids('IFCPROJECT'), records);
}

/** Upgrade reads the effective source project, even when a subset excludes it. */
export function editedTimeScale(store: SourceStore, view: MutablePropertyView | null, index: EffectiveEntityIndex): number | undefined {
  if (!view) return sourceTimeScale(store);
  const source = new SourceRecords(store);
  return resolve(index.byType.get('IFCPROJECT') ?? [], {
    type: id => id === null ? undefined : index.typeOf(id),
    slots: id => {
      if (id === null || !index.has(id)) return undefined;
      if (index.isOverlayCreated(id)) {
        const record = effectiveCreatedRecord(view, id, 'IFC2X3');
        return record ? readStepSlots(record.text)?.slots : undefined;
      }
      const line = source.text(id), type = source.type(id);
      return line && type ? readStepSlots(effectiveSourceRecord(view, id, line, type, 'IFC2X3').text)?.slots : undefined;
    },
  });
}

export function writtenTimeScale(lines: readonly string[], bound: number): (owners?: readonly number[]) => number | undefined {
  const units = new Map<number, NonNullable<ReturnType<typeof readStepSlots>>>();
  const projects: number[] = [];
  for (const line of lines) {
    const head = stepRecordHead(line);
    if (!head) continue;
    const type = line.slice(head.typeStart, head.typeEnd).toUpperCase();
    if (type !== 'IFCPROJECT' && !type.endsWith('UNIT') && type !== 'IFCCONVERSIONBASEDUNITWITHOFFSET' && type !== 'IFCUNITASSIGNMENT') continue;
    const record = readStepSlots(line, bound), id = slotRef(line.slice(0, head.eq));
    if (!record || id === null) continue;
    units.set(id, record);
    if (type === 'IFCPROJECT') projects.push(id);
  }
  return (owners = projects) => resolve(owners, { type: id => units.get(id ?? -1)?.type, slots: id => units.get(id ?? -1)?.slots });
}
