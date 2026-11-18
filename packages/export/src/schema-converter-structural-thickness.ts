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
 * subsequent ones) as that property set when its location aspect is the one
 * point aspect of the member's representation (WR62, WR63), which is where the
 * downgrade takes it back; otherwise both are reported lost. A matching
 * property set the member already has counts the same way. The property set is
 * valid IFC2X3 too and is kept; a member that has one is not given a second.
 * The downgrade reads a native IFC4 member the same way: its property set and
 * the one point aspect of its representation, the only candidate location.
 *
 * Reads the source store, so only an unedited full export arms it.
 */
import { listItems } from './schema-converter-structural-axes.js';
import { bareMeasure, carriedAttributes, conversionMode, readCarrierSets, slotRef, slotUnset, SourceRecords, writeCarrierSet, type ConversionMode, type StructuralRewrite } from './schema-converter-structural-source.js';
import { parseStepNumber } from './step-slot-grammar.js';

const THICKNESS_PSET = 'Pset_StructuralSurfaceMemberVaryingThickness';
const ENTITY = 'IFCSTRUCTURALSURFACEMEMBERVARYING';
const NAMES = ['Thickness1', 'Thickness2', 'Thickness3'];
const THICKNESS_LOCATED = `${THICKNESS_PSET} gives Location properties, which cannot be checked against the IfcShapeAspect order; IFC2X3 SubsequentThickness and VaryingThicknessLocation are not written`;
export const THICKNESS_WRITTEN = `IFC2X3 SubsequentThickness is held in IFC4 as ${THICKNESS_PSET} Thickness1 to Thickness3`;
const THICKNESS_READ = `${THICKNESS_PSET} Thickness1 to Thickness3 are written as the IFC2X3 Thickness and SubsequentThickness, located by the one IfcShapeAspect of the member's representation`;

/** Whether a property record is a single or list value with no value: `$` or `()`. Anything else, or unreadable, counts as a value. */
function emptyValue(type: string | undefined, args: readonly string[] | undefined): boolean {
  if (!args || (type !== 'IFCPROPERTYSINGLEVALUE' && type !== 'IFCPROPERTYLISTVALUE')) return false;
  const value = args[2] ?? '';
  // listItems skips STEP trivia and returns null for anything that is not a readable list.
  return slotUnset(value) || listItems(value)?.length === 0;
}

/** The bare number of a thickness token, `0.2` or `IFCPOSITIVELENGTHMEASURE(0.2)`, or null unless positive. */
function thickness(token: string | undefined): string | null {
  const bare = bareMeasure(token, 'IFCPOSITIVELENGTHMEASURE');
  return bare !== null && parseStepNumber(bare) > 0 ? bare : null;
}

export class StructuralThickness {
  /** The exporter's express-id allocator, shared with every other record it appends. */
  ids: (() => number) | null = null;
  private readonly pending: string[] = [];
  private mode: ConversionMode = null;
  /** IfcProductDefinitionShape id -> the IfcShapeAspects naming it. */
  private readonly aspects = new Map<number, number[]>();
  /** Aspects IFC2X3 admits as VaryingThicknessLocation: each representation one point (WR62, WR63); both directions require it. */
  private readonly pointAspects = new Set<number>();
  /** Member id -> its three thicknesses from a source property set, or [] when it has more than one set. */
  private readonly psets = new Map<number, string[]>();
  /** Members whose property set gives LocationNLocal/LocationNGlobal, which the aspect order cannot be checked against. */
  private readonly located = new Set<number>();

  fromStore(source: SourceRecords, from: string, to: string): void {
    const mode = conversionMode(from, to);
    if (!mode || !source.ids(ENTITY).length) return;
    this.mode = mode;
    // Only the aspects of a varying member's representation are ever asked for.
    const shapes = new Set(source.ids(ENTITY).map((m) => slotRef(source.slots(m)?.[6])));
    for (const id of source.ids('IFCSHAPEASPECT')) {
      const shape = slotRef(source.slots(id)?.[4]);
      if (shape === null || !shapes.has(shape)) continue;
      const list = this.aspects.get(shape) ?? [];
      list.push(id);
      this.aspects.set(shape, list);
      const representations = (listItems(source.slots(id)?.[0] ?? '') ?? []).map(slotRef);
      if (representations.length && representations.every((r) => {
        const items = (listItems(source.slots(r)?.[3] ?? '') ?? []).map(slotRef);
        return items.length === 1 && ['IFCCARTESIANPOINT', 'IFCPOINTONSURFACE'].includes(source.type(items[0]) ?? '');
      })) this.pointAspects.add(id);
    }
    for (const set of readCarrierSets(source, THICKNESS_PSET, false)) {
      const values = NAMES.map((name) => {
        const prop = set.props.get(name);
        const args = source.type(prop ?? null) === 'IFCPROPERTYSINGLEVALUE' ? source.slots(prop!) : undefined;
        // A value in its own unit would need converting; only one in the project's length unit is read.
        return args && slotUnset(args[3] ?? '$') ? thickness(args[2]) : null;
      });
      // A location property counts unless it is a single or list value that is plainly empty.
      const givesLocations = [...set.props].some(([name, prop]) => /^Location[123](?:Local|Global)$/.test(name) && !emptyValue(source.type(prop), source.slots(prop)));
      for (const member of set.related) {
        if (source.type(member) !== ENTITY) continue;
        if (givesLocations) this.located.add(member);
        // A member with two such property sets keeps neither reading.
        this.psets.set(member, this.psets.has(member) || values.includes(null) ? [] : values as string[]);
      }
    }
  }

  /** The one aspect of a representation slot, or null. */
  private aspectOf(representation: string | undefined): number | null {
    const found = this.aspects.get(slotRef(representation) ?? -1);
    return found?.length === 1 ? found[0] : null;
  }

  /**
   * IFC2X3 -> IFC4: the attributes of a varying member IFC4 holds elsewhere:
   * SubsequentThickness and VaryingThicknessLocation, in a matching property
   * set the member has or one this adds, when the location is the
   * representation's one point aspect (WR62, WR63). None otherwise.
   */
  note(id: number, entity: string, args: readonly string[], withheld: ReadonlySet<number> | undefined): readonly string[] {
    // The added property set names only the member; an IFC4 target withholds none, so none is checked.
    if (this.mode !== 'upgrade' || entity !== ENTITY || !this.ids || withheld?.size || args.length !== 11) return [];
    const values = [args[8], ...listItems(args[9]) ?? []].map(thickness);
    if (values.length !== 3 || values.includes(null)) return [];
    // Held only where the location comes back too, so the round trip is exact.
    const location = slotRef(args[10]);
    if (location === null || this.aspectOf(args[6]) !== location || !this.pointAspects.has(location)) return [];
    // A set giving locations is not read back by the downgrade, so it does not hold them.
    if (this.located.has(id)) return [];
    const existing = this.psets.get(id);
    if (existing) {
      // A property set the member already has holds the thicknesses only when its values are these.
      if (existing.length !== 3 || existing.some((v, i) => parseStepNumber(v) !== parseStepNumber(values[i]!))) return [];
    } else {
      const properties = values.map((v, i) => `IFCPROPERTYSINGLEVALUE('${NAMES[i]}',$,IFCPOSITIVELENGTHMEASURE(${v}),$)`);
      this.pending.push(...writeCarrierSet(this.ids, `ifc2x3-thickness:${args[0].trim()}`, args[1], THICKNESS_PSET, id, properties));
    }
    return carriedAttributes('upgrade', ENTITY);
  }

  /** IFC4 -> IFC2X3: why a member the generic path writes has no IFC2X3 thicknesses (`rewrite` leaves located members to it), or undefined. */
  notice(id: number, entity: string, args: readonly string[]): string | undefined {
    return this.mode === 'downgrade' && entity === ENTITY && args.length === 9 && this.located.has(id) ? THICKNESS_LOCATED : undefined;
  }

  /** IFC4 -> IFC2X3: the IFC2X3 member body from its property set and its one aspect, or undefined. */
  rewrite(id: number, entity: string, args: readonly string[]): StructuralRewrite | undefined {
    if (this.mode !== 'downgrade' || entity !== ENTITY || args.length !== 9 || this.located.has(id)) return undefined;
    const [first, ...rest] = this.psets.get(id) ?? [];
    const aspect = this.aspectOf(args[6]);
    if (first === undefined || aspect === null || !this.pointAspects.has(aspect)) return undefined;
    // IFC2X3's VaryingThickness starts with Thickness (WR61 requires it).
    const own = thickness(args[8]);
    if (own !== null && parseStepNumber(own) !== parseStepNumber(first)) return undefined;
    const values = [...args.slice(0, 8), own === null ? first : args[8], `(${rest.join(',')})`, `#${aspect}`];
    return { body: `${ENTITY}(${values.join(',')})`, losses: [THICKNESS_READ] };
  }

  /** Records written so far, to append after the source records. */
  added(): string[] { return this.pending.splice(0); }
}
