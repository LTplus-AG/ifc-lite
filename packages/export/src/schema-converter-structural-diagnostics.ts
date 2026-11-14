/* SPDX-License-Identifier: MPL-2.0 */
/** Matches rust/export/src/schema_structural_diagnostics.rs (#9668). */
import { getSchemaRegistryForVersion, getCanonicalEntityName } from '@ifc-lite/parser';
import { convertEntityType } from './schema-converter.js';
import { isStructuralAssignmentConversion } from './schema-converter-structural.js';
import { StructuralAxes } from './schema-converter-structural-axes.js';
import { readStepSlots } from './step-argument-parser.js';

export class StructuralDiagnostics {
  readonly axes = new StructuralAxes();
  private readonly losses = new Map<string, number>();

  inspect(line: string, from: string, to: string): void {
    const assignment = /^\s*#\d+\s*=\s*IFCRELCONNECTSSTRUCTURALELEMENT\s*\(/i.test(line) ? readStepSlots(line) : null;
    if (assignment && isStructuralAssignmentConversion(assignment.type, from, to)) {
      this.record('IfcRelConnectsStructuralElement is mapped to IfcRelAssignsToProduct; the original relationship kind cannot round trip');
      return;
    }
    if (!((from === 'IFC2X3' && to === 'IFC4') || (from === 'IFC4' && to === 'IFC2X3'))) return;
    if (!/^\s*#\d+\s*=\s*(?:IFCSTRUCTURAL|IFCRELCONNECTSSTRUCTURAL|IFCRELASSOCIATESPROFILEPROPERTIES)/i.test(line)) return;
    const rec = readStepSlots(line);
    if (!rec || !(rec.type.startsWith('IFCSTRUCTURAL') || rec.type.startsWith('IFCRELCONNECTSSTRUCTURAL') || rec.type === 'IFCRELASSOCIATESPROFILEPROPERTIES')) return;
    const source = getSchemaRegistryForVersion(from), target = getSchemaRegistryForVersion(to);
    const name = getCanonicalEntityName(source, rec.type);
    if (!name) return;
    const targetName = getCanonicalEntityName(target, convertEntityType(rec.type, from, to));
    const src = source.entities[name].allAttributes ?? source.entities[name].attributes;
    const meta = targetName ? target.entities[targetName] : undefined;
    if (!meta) {
      const outcome = to === 'IFC4' ? 'record remains unconverted; output does not conform to IFC4' : 'the original entity semantics cannot be retained';
      this.record(`${rec.type} has no representation in ${to}; ${outcome}`);
      return;
    }
    const tgt = (meta.allAttributes ?? meta.attributes).map(a => a.name);
    src.forEach((attr, i) => {
      // CONST is intrinsic to IFC2X3 linear/planar actions, not lost data.
      if (attr.name === 'PredefinedType' && rec.slots[i]?.trim() === '.CONST.'
        && ['IFCSTRUCTURALCURVEACTION', 'IFCSTRUCTURALSURFACEACTION', 'IFCSTRUCTURALLINEARACTION', 'IFCSTRUCTURALPLANARACTION'].includes(rec.type)) return;
      if (attr.name === 'DestabilizingLoad' && rec.slots[i]?.trim() === '$' && to === 'IFC2X3')
        this.record(`${rec.type}.DestabilizingLoad is unknown; IFC2X3 requires a boolean, so the writer substitutes .F.`);
      if (!tgt.includes(attr.name) && rec.slots[i] && !['$', '*', ''].includes(rec.slots[i].trim())) {
        const effect = attr.name === 'ConditionCoordinateSystem' ? '; restraint directions in that coordinate system are not preserved' : '';
        this.record(`${rec.type}.${attr.name} has no slot in ${to}; its value is omitted${effect}`);
      }
    });
    // A tangent does not determine the local section z-axis. Do not invent one.
    if (to === 'IFC4' && tgt.includes('Axis') && !src.some(a => a.name === 'Axis') && !this.axes.axis(line))
      this.record(`${rec.type}.Axis is required by IFC4 but unknown; output does not conform until the model's section orientation is resolved`);
  }

  private record(message: string): void { this.losses.set(message, (this.losses.get(message) ?? 0) + 1); }
  warnings(): string[] { return [...this.losses].sort(([a], [b]) => a.localeCompare(b)).map(([message, count]) => `${count} structural conversion record(s): ${message} (#9668).`); }
}
