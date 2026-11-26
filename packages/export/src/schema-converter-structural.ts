/* SPDX-License-Identifier: MPL-2.0 */
/** Browser adapter for rust/export/src/schema_structural.rs (#9668). */
import { parseStepNumber, skipStepTrivia } from './step-slot-grammar.js';
import { readStepSlots } from './step-argument-parser.js';
import { getSchemaRegistryForVersion, type SchemaVersionWithRegistry } from '@ifc-lite/parser';

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

/** Whether `from` -> `to` is IFC2X3 to or from IFC4 or IFC4X3. */
function ifc2x3AndIfc4Family(from: string, to: string): boolean {
  const other = from === 'IFC2X3' ? to : to === 'IFC2X3' ? from : undefined;
  return other === 'IFC4' || other === 'IFC4X3';
}

export const isRegistrySchema = (schema: string): schema is SchemaVersionWithRegistry => schema === 'IFC2X3' || schema === 'IFC4' || schema === 'IFC4X3';

/** IFC2X3's stiffness fields keep their position and units in IFC4 and IFC4X3. */
export function isStructuralStiffnessConversion(entity: string, from: string, to: string): boolean {
  return ifc2x3AndIfc4Family(from, to) && stiffnessType(entity, 1) !== null;
}

/** The loss reported when IFC2X3's required DestabilizingLoad is written as .F. for an unknown value. */
export const destabilizingUnknown = (entity: string): string => `${entity}.DestabilizingLoad is unknown; IFC2X3 requires a boolean, so the writer substitutes .F.`;

/** One target policy shared by rewriting, preview and diagnostics. */
export function isStructuralAssignmentConversion(entity: string, from: string, to: string): boolean {
  return entity === 'IFCRELCONNECTSSTRUCTURALELEMENT' && from === 'IFC2X3' && ['IFC4', 'IFC4X3', 'IFC5'].includes(to);
}

/** A constant linear or planar action between IFC2X3 and IFC4 or IFC4X3, mapped by attribute name:
 *  IFC2X3's CausedBy has no slot in either, and both declare the same layout (#11571). */
export function isConstantActionConversion(entity: string, from: string, to: string): boolean {
  return ifc2x3AndIfc4Family(from, to) && (entity === 'IFCSTRUCTURALLINEARACTION' || entity === 'IFCSTRUCTURALPLANARACTION');
}

export function structuralAttributes(entity: string, args: readonly string[], from: string, to: string): string | null {
  if (isStructuralAssignmentConversion(entity, from, to) && args.length === 6) {
    // IFC4's analytical assignment retains both objects, but changes relationship kind.
    return `${args.slice(0, 4).join(',')},(${args[5]}),$,${args[4]}`;
  }
  if (isStructuralStiffnessConversion(entity, from, to)) {
    const values = [...args];
    for (let i = 1; i < values.length; i++) {
      const measure = stiffnessType(entity, i), token = values[i].trim();
      if (!measure || scalarEquals(token, '$')) continue;
      if (from === 'IFC2X3') {
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
  if (!isConstantActionConversion(entity, from, to) || !isRegistrySchema(from) || !isRegistrySchema(to)) return null;
  const name = entity === 'IFCSTRUCTURALLINEARACTION' ? 'IfcStructuralLinearAction' : 'IfcStructuralPlanarAction';
  const slots = (schema: SchemaVersionWithRegistry) => getSchemaRegistryForVersion(schema).entities[name]?.allAttributes?.map(a => a.name);
  const src = slots(from), tgt = slots(to);
  if (!src || !tgt) return null;
  return tgt.map(name => args[src.indexOf(name)] ?? (name === 'PredefinedType' ? '.CONST.' : '$')).join(',');
}
