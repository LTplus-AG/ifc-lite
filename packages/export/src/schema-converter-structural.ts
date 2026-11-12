/* SPDX-License-Identifier: MPL-2.0 */
/** Browser adapter for rust/export/src/schema_structural.rs (#9668). */
import { getSchemaRegistryForVersion } from '@ifc-lite/parser';

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

export function structuralAttributes(entity: string, args: readonly string[], from: string, to: string): string | null {
  if (entity === 'IFCRELCONNECTSSTRUCTURALELEMENT' && from === 'IFC2X3' && ['IFC4', 'IFC4X3', 'IFC5'].includes(to) && args.length === 6) {
    // IFC4's analytical assignment retains both objects, but changes relationship kind.
    return `${args.slice(0, 4).join(',')},(${args[5]}),$,${args[4]}`;
  }
  if (!((from === 'IFC2X3' && to === 'IFC4') || (from === 'IFC4' && to === 'IFC2X3'))) return null;
  if (stiffnessType(entity, 1)) {
    const values = [...args];
    for (let i = 1; i < values.length; i++) {
      const measure = stiffnessType(entity, i), token = values[i].trim();
      if (!measure || token === '$') continue;
      if (to === 'IFC4') {
        // IFC2X3's -1 sentinel means rigid. Zero retains its measure encoding.
        values[i] = Number(token) === -1 ? 'IFCBOOLEAN(.T.)' : `${measure}(${token})`;
      } else {
        const typed = token.match(/^(\w+)\((.*)\)$/);
        if (!typed) continue;
        if (typed[1].toUpperCase() === 'IFCBOOLEAN') {
          if (typed[2].trim() !== '.T.' && typed[2].trim() !== '.F.') return null;
          values[i] = typed[2].trim() === '.T.' ? '-1.' : '0.';
        } else if (typed[1].toUpperCase() === measure) values[i] = typed[2];
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
