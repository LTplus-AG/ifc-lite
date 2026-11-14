/* SPDX-License-Identifier: MPL-2.0 */
/** Browser adapter for rust/export/src/schema_structural.rs (#9668). */
import { parseStepNumber, skipStepTrivia } from './step-slot-grammar.js';
import { readStepSlots } from './step-argument-parser.js';
import { getSchemaRegistryForVersion } from '@ifc-lite/parser';

function scalarEquals(token: string, value: string): boolean {
  const start = skipStepTrivia(token, 0);
  return start >= 0 && token.slice(start, start + value.length).toUpperCase() === value.toUpperCase()
    && skipStepTrivia(token, start + value.length) === token.length;
}

function stiffnessType(entity: string, index: number): string | null {
  if (entity === 'IFCBOUNDARYNODECONDITIONWARPING' && index === 7) return 'IFCWARPINGMOMENTMEASURE';
  if (index < 1 || index > 6) return null;
  if (entity === 'IFCBOUNDARYNODECONDITION' || entity === 'IFCBOUNDARYNODECONDITIONWARPING')
    return index <= 3 ? 'IFCLINEARSTIFFNESSMEASURE' : 'IFCROTATIONALSTIFFNESSMEASURE';
  if (entity === 'IFCBOUNDARYEDGECONDITION')
    return index <= 3 ? 'IFCMODULUSOFLINEARSUBGRADEREACTIONMEASURE' : 'IFCMODULUSOFROTATIONALSUBGRADEREACTIONMEASURE';
  if (entity === 'IFCBOUNDARYFACECONDITION' && index <= 3) return 'IFCMODULUSOFSUBGRADEREACTIONMEASURE';
  return null;
}

/** Same semantic stiffness fields; only their EXPRESS names/value wrappers changed. */
export function isStructuralBoundaryCondition(entity: string): boolean { return stiffnessType(entity, 1) !== null; }

/** One target policy shared by rewriting, preview and diagnostics. */
export function isStructuralAssignmentConversion(entity: string, from: string, to: string): boolean {
  return entity === 'IFCRELCONNECTSSTRUCTURALELEMENT' && from === 'IFC2X3' && ['IFC4', 'IFC4X3', 'IFC5'].includes(to);
}

export function structuralAttributes(entity: string, args: readonly string[], from: string, to: string): string | null {
  if (isStructuralAssignmentConversion(entity, from, to) && args.length === 6) {
    // IFC4's analytical assignment retains both objects, but changes relationship kind.
    return `${args.slice(0, 4).join(',')},(${args[5]}),$,${args[4]}`;
  }
  if (!((from === 'IFC2X3' && to === 'IFC4') || (from === 'IFC4' && to === 'IFC2X3'))) return null;
  if (stiffnessType(entity, 1)) {
    const values = [...args];
    for (let i = 1; i < values.length; i++) {
      const measure = stiffnessType(entity, i), token = values[i].trim();
      if (!measure || scalarEquals(token, '$')) continue;
      if (to === 'IFC4') {
        // IFC2X3's -1 sentinel means rigid. Zero retains its measure encoding.
        values[i] = parseStepNumber(token) === -1 ? 'IFCBOOLEAN(.T.)' : `${measure}(${token})`;
      } else {
        const typed = readStepSlots(`#0=${token};`);
        if (!typed || typed.slots.length !== 1) return null;
        if (typed.type === 'IFCBOOLEAN') {
          if (scalarEquals(typed.slots[0], '.T.')) values[i] = '-1.';
          else if (scalarEquals(typed.slots[0], '.F.')) values[i] = '0.';
          else return null;
        } else if (typed.type === measure) values[i] = typed.slots[0];
        else return null;
      }
    }
    return values.join(',');
  }
  if (entity !== 'IFCSTRUCTURALLINEARACTION' && entity !== 'IFCSTRUCTURALPLANARACTION') return null;
  const name = entity === 'IFCSTRUCTURALLINEARACTION' ? 'IfcStructuralLinearAction' : 'IfcStructuralPlanarAction';
  const slots = (schema: 'IFC2X3' | 'IFC4') => getSchemaRegistryForVersion(schema).entities[name]?.allAttributes?.map(a => a.name);
  const src = slots(from), tgt = slots(to);
  if (!src || !tgt) return null;
  return tgt.map(name => args[src.indexOf(name)] ?? (name === 'PredefinedType' ? '.CONST.' : '$')).join(',');
}
