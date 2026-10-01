/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SCHEMA_REGISTRY, SI_PREFIX_MULTIPLIERS } from '@ifc-lite/parser';
import { readStepSlots, splitTopLevelListItems, type StepRecordSlots } from './step-argument-parser.js';
import { attrIndex, stepSourceSchema } from './subset-entity-reader.js';
import { resolveExpressBase, toStepReal } from './step-serialization.js';
import type { ExportPass } from './step-export-types.js';

interface RecordEntry { id: number; index: number; record: StepRecordSlots }
const ref = (token: string | undefined): number | undefined => token?.match(/^#([0-9]+)$/) ? Number(token.slice(1)) : undefined;
const enumeration = (token: string | undefined): string => token?.replaceAll('.', '').toUpperCase() ?? '';
const real = (token: string | undefined): number => token !== undefined && /^[+-]?[0-9]+\.[0-9]*(?:E[+-]?[0-9]+)?$/i.test(token) ? Number(token) : NaN;
const definedTypes = new Map(Object.keys(SCHEMA_REGISTRY.types).map(name => [name.toUpperCase(), name]));
const maps = new Set(['IFCMAPCONVERSION', 'IFCMAPCONVERSIONSCALED']);

/** Normalize the *emitted* model, after named/positional/created-entity edits.
 * Never rewrite a shared project unit. Each CRS and all its operations change
 * atomically; a refusal leaves that CRS byte-identical and is reported (#6587).
 */
export function normalizeMapUnitsToMetres(pass: ExportPass, allocateId: () => number): void {
  const records = new Map<number, RecordEntry>();
  const operations = new Map<number, RecordEntry[]>();
  let unreadableOperation = false;
  const schema = stepSourceSchema(pass.sourceSchema);
  for (let index = 0; index < pass.entities.length; index++) {
    const line = pass.entities[index];
    const prefix = /^#([0-9]+)\s*=\s*(\w+)/.exec(line);
    if (!prefix) continue;
    const type = prefix[2].toUpperCase();
    const targetSlot = attrIndex(type, 'TargetCRS', schema);
    if (targetSlot < 0 && !['IFCSIUNIT', 'IFCCONVERSIONBASEDUNIT', 'IFCMEASUREWITHUNIT', 'IFCPROJECTEDCRS', 'IFCPROJECT', 'IFCUNITASSIGNMENT', 'IFCWELLKNOWNTEXT'].includes(type)) continue;
    const record = readStepSlots(line);
    if (!record) { if (targetSlot >= 0) unreadableOperation = true; continue; }
    const entry = { id: Number(prefix[1]), index, record };
    records.set(entry.id, entry);
    if (targetSlot >= 0) {
      const target = ref(record.slots[targetSlot]?.trim());
      if (target !== undefined) {
        const list = operations.get(target) ?? [];
        list.push(entry); operations.set(target, list);
      }
    }
  }
  let metreId = [...records.values()].find(({ record }) => record.type === 'IFCSIUNIT'
    && enumeration(record.slots[1]) === 'LENGTHUNIT' && record.slots[2]?.trim() === '$'
    && enumeration(record.slots[3]) === 'METRE')?.id;
  const warn = (id: number, reason: string): void => {
    const message = `Cannot normalize IfcProjectedCRS #${id} map units to metres: ${reason}. Its map units and coordinate operations were preserved.`;
    pass.warnings.push(message); console.warn(`[StepExporter] ${message}`);
  };
  for (const target of operations.keys()) {
    if (records.get(target)?.record.type !== 'IFCPROJECTEDCRS') {
      warn(target, 'the target is not a retained IfcProjectedCRS');
    }
  }
  for (const crs of records.values()) {
    if (crs.record.type !== 'IFCPROJECTEDCRS') continue;
    const consumers = operations.get(crs.id) ?? [];
    if (unreadableOperation) { warn(crs.id, 'a retained coordinate operation cannot be parsed safely'); continue; }
    if (!consumers.length) continue;
    const name = crs.record.slots[0]?.trim() ?? '';
    if (/^'[A-Z_]+\s*\[/i.test(name)
      || [...records.values()].some(({ record }) => record.type === 'IFCWELLKNOWNTEXT' && ref(record.slots[1]?.trim()) === crs.id)) {
      warn(crs.id, 'a retained WKT definition may declare its own coordinate units'); continue;
    }
    const authoredUnit = crs.record.slots[6]?.trim();
    const unitId = authoredUnit === '$' ? projectUnitForContexts(consumers, records, schema) : ref(authoredUnit);
    const factor = unitId === undefined ? undefined : lengthUnitFactor(unitId, records);
    if (factor === undefined) { warn(crs.id, 'the applicable length unit is missing, ambiguous, or unsupported'); continue; }
    if (factor === 1) continue;
    if (consumers.some(({ record }) => !maps.has(record.type))) {
      warn(crs.id, 'a retained coordinate operation is not an IfcMapConversion'); continue;
    }
    const replacements = new Map<RecordEntry, string[]>();
    for (const operation of consumers) {
      const slots = operation.record.slots.map(token => token.trim());
      const values = [2, 3, 4, 7].map(index => index === 7 && slots[index] === '$' ? 1 : real(slots[index]));
      if (slots.length < 8 || values.some(value => !Number.isFinite(value))
        || values[3] <= 0 || values.some(value => !Number.isFinite(value * factor))
        || values[3] * factor <= 0) break;
      [2, 3, 4, 7].forEach((index, position) => { slots[index] = toStepReal(values[position] * factor); });
      replacements.set(operation, slots);
    }
    if (replacements.size !== consumers.length) { warn(crs.id, 'a coordinate operation has invalid offsets or scale'); continue; }
    if (metreId === undefined) {
      metreId = allocateId();
      pass.entities.push(`#${metreId}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
      pass.newEntityCount++;
    }
    const slots = crs.record.slots.map(token => token.trim());
    slots[6] = `#${metreId}`;
    replacements.set(crs, slots);
    for (const [entry, updated] of replacements) {
      pass.entities[entry.index] = `${entry.record.prefix}${updated.join(',')}${entry.record.suffix}`;
      // Newly created entities already contribute to newEntityCount; source
      // entities count once even if an earlier session edit changed them too.
      if (!pass.effective.isOverlayCreated(entry.id) && pass.effective.has(entry.id)) {
        pass.modifications.nominate(entry.id, 'georeferencing');
        pass.modifications.recordEmitted(entry.id, 'georeferencing');
      }
    }
  }
}

/** Bounded, iterative conversion-factor walk; no implicit metre fallback. */
function lengthUnitFactor(id: number, records: Map<number, RecordEntry>): number | undefined {
  const visited = new Set<number>();
  let factor = 1;
  let current: number | undefined = id;
  while (current !== undefined && !visited.has(current) && visited.size <= records.size) {
    visited.add(current);
    const record = records.get(current)?.record;
    if (!record || enumeration(record.slots[1]) !== 'LENGTHUNIT') return undefined;
    if (record.type === 'IFCSIUNIT') {
      if (enumeration(record.slots[3]) !== 'METRE') return undefined;
      const prefix = record.slots[2]?.trim();
      const multiplier = prefix === '$' ? 1 : SI_PREFIX_MULTIPLIERS[enumeration(prefix)];
      const result = factor * multiplier;
      return Number.isFinite(result) && result > 0 ? result : undefined;
    }
    if (record.type !== 'IFCCONVERSIONBASEDUNIT') return undefined;
    const measure = records.get(ref(record.slots[3]?.trim()) ?? -1)?.record;
    if (measure?.type !== 'IFCMEASUREWITHUNIT') return undefined;
    const value = measure.slots[0]?.trim();
    const typed = /^([A-Z][A-Z0-9_]*)\(([^()]+)\)$/i.exec(value ?? '');
    const base = typed ? resolveExpressBase(definedTypes.get(typed[1].toUpperCase()) ?? typed[1]) : 'REAL';
    const token = typed ? typed[2] : value;
    const scale = base === 'REAL' || base === 'NUMBER' ? real(token)
      : base === 'INTEGER' && token !== undefined && /^[+-]?[0-9]+$/.test(token) ? Number(token) : NaN;
    if (!Number.isFinite(scale) || scale <= 0) return undefined;
    factor *= scale;
    if (!Number.isFinite(factor) || factor <= 0) return undefined;
    current = ref(measure.slots[1]?.trim());
  }
  return undefined;
}

/** Missing MapUnit inherits its SourceCRS project's length unit. Every
 * operation sharing this CRS must resolve to the same declared unit factor.
 * Contexts are matched through IfcProject.RepresentationContexts, not the
 * first project in a federated file. Ambiguous owners are refused.
 */
function projectUnitForContexts(consumers: RecordEntry[], records: Map<number, RecordEntry>, schema: ReturnType<typeof stepSourceSchema>): number | undefined {
  let chosen: number | undefined;
  for (const consumer of consumers) {
    const context = ref(consumer.record.slots[0]?.trim());
    const owners = [...records.values()].filter(({ record }) => record.type === 'IFCPROJECT'
      && splitTopLevelListItems(record.slots[attrIndex('IFCPROJECT', 'RepresentationContexts', schema)]?.trim().slice(1, -1) ?? '')
        .some(token => ref(token.trim()) === context));
    if (context === undefined || owners.length !== 1) return undefined;
    const assignment = records.get(ref(owners[0].record.slots[attrIndex('IFCPROJECT', 'UnitsInContext', schema)]?.trim()) ?? -1)?.record;
    if (assignment?.type !== 'IFCUNITASSIGNMENT') return undefined;
    const units = splitTopLevelListItems(assignment.slots[0]?.trim().slice(1, -1) ?? '')
      .map(token => ref(token.trim())).filter((id): id is number => id !== undefined
        && enumeration(records.get(id)?.record.slots[1]) === 'LENGTHUNIT');
    if (units.length !== 1) return undefined;
    if (chosen !== undefined && lengthUnitFactor(chosen, records) !== lengthUnitFactor(units[0], records)) return undefined;
    chosen = units[0];
  }
  return chosen;
}
