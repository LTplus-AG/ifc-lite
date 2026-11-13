/* SPDX-License-Identifier: MPL-2.0 */
/** Matches rust/export/src/schema_structural_axes.rs (#9668). */
import type { IfcDataStore } from '@ifc-lite/parser';
import { readStepSlots } from './step-argument-parser.js';
import { parseStepNumber, skipStepTrivia } from './step-slot-grammar.js';
import { decodeRange } from './source-ref-bounds.js';
const ref = (s: string): number | null => /^#\s*\d+$/.test(s.trim()) ? Number(s.trim().slice(1)) : null;

function listItems(token: string): readonly string[] | null {
  const start = skipStepTrivia(token, 0);
  if (start < 0 || token[start] !== '(') return null;
  // Reuse the shared record frame for a standalone tuple, including trailing
  // comments containing ')'. This parsing envelope is never exported.
  return readStepSlots(`#0=IFCDIRECTION${token};`)?.slots ?? null;
}

export class StructuralAxes {
  private readonly axes = new Map<number, number | null>();
  private readonly directions = new Set<number>();

  note(line: string): void {
    const rec = readStepSlots(line), id = /^\s*#(\d+)/.exec(line)?.[1];
    if (!rec || !id) return;
    if (rec.type === 'IFCDIRECTION') {
      const values = listItems(rec.slots[0] ?? '')?.map(parseStepNumber);
      if (values?.length === 3 && values.every(Number.isFinite) && values.some(x => x !== 0)) this.directions.add(Number(id));
    } else if (rec.type === 'IFCRELASSOCIATESPROFILEPROPERTIES' && rec.slots.length === 8) {
      const axis = ref(rec.slots[7]);
      for (const token of listItems(rec.slots[4]) ?? []) {
        const member = ref(token);
        if (member === null) continue;
        this.axes.set(member, this.axes.has(member) && this.axes.get(member) !== axis ? null : axis);
      }
    }
  }

  fromStore(store: IfcDataStore): void {
    for (const type of ['IFCRELASSOCIATESPROFILEPROPERTIES', 'IFCDIRECTION']) {
      // @raw-entity-enumeration-ok conversion prepass is enabled only for an unedited full-source export
      for (const id of store.entityIndex.byType.get(type) ?? []) {
        // @raw-entity-enumeration-ok same unedited source-only prepass
        const entry = store.entityIndex.byId.get(id);
        if (entry) this.note(decodeRange(store.source, entry.byteOffset, entry.byteOffset + entry.byteLength));
      }
    }
  }

  axis(line: string): string | undefined {
    if (!/^\s*#\d+\s*=\s*IFCSTRUCTURALCURVEMEMBER(?:VARYING)?\s*\(/i.test(line)) return undefined;
    const rec = readStepSlots(line), id = /^\s*#(\d+)/.exec(line)?.[1];
    // Profile directions are in the analysis frame. A placed member needs a
    // coordinate transform; angles/defaults/conflicting orientations stay unknown.
    if (!rec || !id || !['IFCSTRUCTURALCURVEMEMBER', 'IFCSTRUCTURALCURVEMEMBERVARYING'].includes(rec.type)
      || rec.slots.length !== 8 || rec.slots[5].trim() !== '$') return undefined;
    const axis = this.axes.get(Number(id));
    return axis != null && this.directions.has(axis) ? `#${axis}` : undefined;
  }
}
