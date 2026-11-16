/* SPDX-License-Identifier: MPL-2.0 */
/**
 * Varying surface member thickness IFC2X3 <-> IFC4 (#9668). IFC4 deleted
 * IfcStructuralSurfaceMemberVarying.SubsequentThickness and
 * VaryingThicknessLocation and gives the thicknesses by
 * Pset_StructuralSurfaceMemberVaryingThickness (IFC4 IfcStructuralSurfaceMemberVarying:
 * "properties are provided by means of Pset_StructuralSurfaceMemberVaryingThickness"),
 * which holds three: Thickness1 to Thickness3.
 *
 * The upgrade writes an IFC2X3 member with three thicknesses (Thickness and two
 * subsequent ones) as that property set. Its location aspect stays on the
 * member's representation, so the upgrade requires it to be the one aspect
 * there, and the downgrade takes that aspect back. The property set is valid
 * IFC2X3 too and is kept; a member that has one is not given a second.
 *
 * Reads the source store, so only an unedited full export arms it.
 */
import { listItems } from './schema-converter-structural-axes.js';
import { conversionMode, readCarrierSets, SourceRecords, writeCarrierSet, type ConversionMode, type StructuralRewrite } from './schema-converter-structural-source.js';
import { refId } from './schema-ifc2x3-records.js';
import { parseStepNumber } from './step-slot-grammar.js';

export const THICKNESS_PSET = 'Pset_StructuralSurfaceMemberVaryingThickness';
const ENTITY = 'IFCSTRUCTURALSURFACEMEMBERVARYING';
const NAMES = ['Thickness1', 'Thickness2', 'Thickness3'];
export const THICKNESS_WRITTEN = `IFC2X3 SubsequentThickness is written as ${THICKNESS_PSET} Thickness1 to Thickness3; the IfcShapeAspect locating them stays on the member's representation`;
export const THICKNESS_READ = `${THICKNESS_PSET} Thickness1 to Thickness3 are written as the IFC2X3 Thickness and SubsequentThickness, located by the one IfcShapeAspect of the member's representation`;

/** The bare number of a thickness token, `0.2` or `IFCPOSITIVELENGTHMEASURE(0.2)`, or null unless positive. */
function thickness(token: string | undefined): string | null {
  const bare = /^\s*IFCPOSITIVELENGTHMEASURE\s*\((.*)\)\s*$/i.exec(token ?? '')?.[1] ?? token ?? '';
  return parseStepNumber(bare) > 0 ? bare.trim() : null;
}

export class StructuralThickness {
  /** The exporter's express-id allocator, shared with every other record it appends. */
  ids: (() => number) | null = null;
  private readonly pending: string[] = [];
  private mode: ConversionMode = null;
  /** IfcProductDefinitionShape id -> the IfcShapeAspects naming it. */
  private readonly aspects = new Map<number, number[]>();
  /** Member id -> its three thicknesses from a source property set, or [] when it has more than one set. */
  private readonly psets = new Map<number, string[]>();

  fromStore(source: SourceRecords, from: string, to: string): void {
    const mode = conversionMode(from, to);
    if (!mode || !source.ids(ENTITY).length) return;
    this.mode = mode;
    for (const id of source.ids('IFCSHAPEASPECT')) {
      const shape = refId(source.slots(id)?.[4]);
      if (shape === null) continue;
      const list = this.aspects.get(shape) ?? [];
      list.push(id);
      this.aspects.set(shape, list);
    }
    for (const set of readCarrierSets(source, THICKNESS_PSET)) {
      const values = NAMES.map((name) => {
        const prop = set.props.get(name);
        return source.type(prop ?? null) === 'IFCPROPERTYSINGLEVALUE' ? thickness(source.slots(prop!)?.[2]) : null;
      });
      for (const member of set.related) {
        if (source.type(member) !== ENTITY) continue;
        // A member with two such property sets keeps neither reading.
        this.psets.set(member, this.psets.has(member) || values.includes(null) ? [] : values as string[]);
      }
    }
  }

  /** The one aspect of a representation slot, or null. */
  private aspectOf(representation: string | undefined): number | null {
    const found = this.aspects.get(refId(representation) ?? -1);
    return found?.length === 1 ? found[0] : null;
  }

  /** IFC2X3 -> IFC4: adds the property set for a member's thicknesses. True when IFC4 holds them. */
  note(id: number, entity: string, args: readonly string[]): boolean {
    if (this.mode !== 'upgrade' || entity !== ENTITY || !this.ids || args.length !== 11) return false;
    const values = [args[8], ...listItems(args[9]) ?? []].map(thickness);
    const location = refId(args[10]);
    if (values.length !== 3 || values.includes(null) || location === null || this.aspectOf(args[6]) !== location) return false;
    // A property set the member already has holds the thicknesses only when its values are these.
    const existing = this.psets.get(id);
    if (existing) return existing.length === 3 && existing.every((v, i) => parseStepNumber(v) === parseStepNumber(values[i]!));
    const properties = values.map((v, i) => `IFCPROPERTYSINGLEVALUE('${NAMES[i]}',$,IFCPOSITIVELENGTHMEASURE(${v}),$)`);
    this.pending.push(...writeCarrierSet(this.ids, `ifc2x3-thickness:${args[0].trim()}`, args[1], THICKNESS_PSET, id, properties));
    return true;
  }

  /** IFC4 -> IFC2X3: the IFC2X3 member body from its property set and its one aspect, or undefined. */
  rewrite(id: number, entity: string, args: readonly string[]): StructuralRewrite | undefined {
    if (this.mode !== 'downgrade' || entity !== ENTITY || args.length !== 9) return undefined;
    const [first, ...rest] = this.psets.get(id) ?? [];
    const aspect = this.aspectOf(args[6]);
    if (first === undefined || aspect === null) return undefined;
    // IFC2X3's VaryingThickness starts with Thickness (WR61 requires it).
    const own = thickness(args[8]);
    if (own !== null && parseStepNumber(own) !== parseStepNumber(first)) return undefined;
    const values = [...args.slice(0, 8), own === null ? first : args[8], `(${rest.join(',')})`, `#${aspect}`];
    return { body: `${ENTITY}(${values.join(',')})`, losses: [THICKNESS_READ] };
  }

  /** Records written so far, to append after the source records. */
  added(): string[] { return this.pending.splice(0); }
}
