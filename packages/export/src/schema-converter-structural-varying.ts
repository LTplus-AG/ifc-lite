/* SPDX-License-Identifier: MPL-2.0 */
/** Matches rust/export/src/schema_structural_varying.rs (#9668). */
import type { IfcDataStore } from '@ifc-lite/parser';
import { destabilizingUnknown } from './schema-converter-structural.js';
import { listItems } from './schema-converter-structural-axes.js';
import { refId } from './schema-ifc2x3-records.js';
import { decodeRange } from './source-ref-bounds.js';
import { readStepSlots } from './step-argument-parser.js';

/**
 * IFC2X3's varying actions and the IFC4 actions they become. IFC4 dropped
 * IfcStructuralLinearActionVarying and IfcStructuralPlanarActionVarying
 * (IFC2X3_TC1.exp:7312, :7427). It holds several load values as an
 * IfcStructuralCurveAction or IfcStructuralSurfaceAction whose AppliedLoad is an
 * IfcStructuralLoadConfiguration (IFC4_ADD2_TC1.exp:9399, :9625, :9470).
 * `first` is what the IFC2X3 supertype's WR61 admits as AppliedLoad
 * (IFC2X3_TC1.exp:7301 and IfcStructuralPlanarAction); both directions take
 * only loads that all share one of those types. `min` is the size of
 * VaryingAppliedLoads (LIST [2:?] linear, [3:?] planar).
 */
const KINDS = [
  { ifc2x3: 'IFCSTRUCTURALLINEARACTIONVARYING', ifc4: 'IFCSTRUCTURALCURVEACTION', first: ['IFCSTRUCTURALLOADLINEARFORCE', 'IFCSTRUCTURALLOADTEMPERATURE'], min: 2 },
  { ifc2x3: 'IFCSTRUCTURALPLANARACTIONVARYING', ifc4: 'IFCSTRUCTURALSURFACEACTION', first: ['IFCSTRUCTURALLOADPLANARFORCE', 'IFCSTRUCTURALLOADTEMPERATURE'], min: 3 },
] as const;

const FROM_IFC2X3 = 'an IFC2X3 varying action is written as an IFC4 curve or surface action with PredefinedType NOTDEFINED and an IfcStructuralLoadConfiguration holding its loads without Locations; the IfcShapeAspect of its representation keeps the locations';
const TO_IFC2X3 = 'an IFC4 curve or surface action with an IfcStructuralLoadConfiguration is written as an IFC2X3 varying action, its locations taken from the one IfcShapeAspect of its representation; the configuration Name, Locations and the action PredefinedType have no slot in IFC2X3';

export interface Rewrite { readonly body: string; readonly losses: readonly string[] }
type Kind = (typeof KINDS)[number];

/**
 * Converts varying actions in both directions, and only those that convert
 * back: one test (`convertible`) decides both, so a configuration this writes
 * on the way up is one the way down consumes. It reads the source store (the
 * shape aspects, the load types and, on the way down, the configurations) and
 * takes fresh express ids on the way up, so only an unedited full export arms it.
 */
export class StructuralVarying {
  /** The exporter's express-id allocator, shared with every other record it appends. */
  ids: (() => number) | null = null;
  private readonly pending: string[] = [];
  private mode: 'upgrade' | 'downgrade' | null = null;
  private typeOf: (id: number) => string = () => '';
  /** IFC4 IfcStructuralLoadConfiguration id -> its values. */
  private readonly configs = new Map<number, number[]>();
  /** IfcProductDefinitionShape id -> the IfcShapeAspects naming it as PartOfProductDefinitionShape. */
  private readonly aspects = new Map<number, number[]>();

  fromStore(store: IfcDataStore, from: string, to: string): void {
    const mode = from === 'IFC2X3' && to === 'IFC4' ? 'upgrade' : from === 'IFC4' && to === 'IFC2X3' ? 'downgrade' : null;
    // @raw-entity-enumeration-ok conversion prepass is enabled only for an unedited full-source export
    const { byId, byType } = store.entityIndex;
    const sources = mode === 'upgrade' ? KINDS.map((k) => k.ifc2x3) : ['IFCSTRUCTURALLOADCONFIGURATION'];
    if (!mode || !sources.some((type) => byType.get(type)?.length)) return;
    const slots = (id: number) => {
      const entry = byId.get(id);
      return entry ? readStepSlots(decodeRange(store.source, entry.byteOffset, entry.byteOffset + entry.byteLength))?.slots : undefined;
    };
    for (const id of byType.get('IFCSHAPEASPECT') ?? []) {
      const shape = refId(slots(id)?.[4]);
      if (shape === null) continue;
      const list = this.aspects.get(shape) ?? [];
      list.push(id);
      this.aspects.set(shape, list);
    }
    for (const id of mode === 'downgrade' ? byType.get('IFCSTRUCTURALLOADCONFIGURATION') ?? [] : []) {
      const values = listItems(slots(id)?.[1] ?? '')?.map(refId);
      if (values?.length && values.every((v) => v !== null)) this.configs.set(id, values as number[]);
    }
    this.mode = mode;
    this.typeOf = (id) => byId.get(id)?.type.toUpperCase() ?? '';
  }

  /** The target record body for a varying action of either schema, or undefined. */
  rewrite(entity: string, args: readonly string[]): Rewrite | undefined {
    return this.mode === 'upgrade' ? this.toIfc4(entity, args) : this.mode === 'downgrade' ? this.toIfc2x3(entity, args) : undefined;
  }

  /** IfcStructuralLoadConfiguration records written so far, to append after the source records. */
  added(): string[] { return this.pending.splice(0); }

  /**
   * The shape aspect locating `loads` when both schemas hold the action: the
   * one aspect of its representation (and `location`, when IFC2X3 names one),
   * enough loads, all of one type that the IFC2X3 WR61 admits.
   */
  private convertible(kind: Kind, representation: string, loads: readonly (number | null)[], location?: number | null): number | undefined {
    const found = this.aspects.get(refId(representation) ?? -1);
    if (found?.length !== 1 || (location !== undefined && found[0] !== location) || loads.length < kind.min) return undefined;
    const type = loads[0] === null ? '' : this.typeOf(loads[0]);
    const first: readonly string[] = kind.first;
    return first.includes(type) && loads.every((l) => l !== null && this.typeOf(l) === type) ? found[0] : undefined;
  }

  private toIfc4(entity: string, args: readonly string[]): Rewrite | undefined {
    const kind = KINDS.find((k) => k.ifc2x3 === entity);
    if (!kind || !this.ids || args.length !== 14) return undefined;
    const loads = [args[7], ...(listItems(args[13]) ?? [])].map(refId);
    if (this.convertible(kind, args[6], loads, refId(args[12])) === undefined) return undefined;
    const id = this.ids();
    this.pending.push(`#${id}=IFCSTRUCTURALLOADCONFIGURATION($,(${loads.map((l) => `#${l}`).join(',')}),$);`);
    const losses = [FROM_IFC2X3];
    if (args[10].trim() !== '$') losses.push(`${entity}.CausedBy has no slot in IFC4; its value is omitted`);
    return { body: `${kind.ifc4}(${[...args.slice(0, 7), `#${id}`, args[8], args[9], args[11], '.NOTDEFINED.'].join(',')})`, losses };
  }

  private toIfc2x3(entity: string, args: readonly string[]): Rewrite | undefined {
    const kind = KINDS.find((k) => k.ifc4 === entity);
    if (!kind || args.length !== 12 || args[11].trim().toUpperCase() === '.CONST.') return undefined;
    const values = this.configs.get(refId(args[7]) ?? -1);
    const aspect = values && this.convertible(kind, args[6], values);
    if (!values || aspect === undefined) return undefined;
    const [first, ...rest] = values.map((v) => `#${v}`);
    // `inspect` reports this for the records it sees; a rewritten one skips it.
    const losses = [TO_IFC2X3, ...(args[9].trim() === '$' ? [destabilizingUnknown(entity)] : [])];
    return { body: `${kind.ifc2x3}(${[...args.slice(0, 7), first, args[8], args[9], '$', args[10], `#${aspect}`, `(${rest.join(',')})`].join(',')})`, losses };
  }
}
