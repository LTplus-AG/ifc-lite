/* SPDX-License-Identifier: MPL-2.0 */
/** Matches rust/export/src/schema_structural_varying.rs (#9668). */
import { destabilizingUnknown } from './schema-converter-structural.js';
import { listItems } from './schema-converter-structural-axes.js';
import { refId } from './schema-ifc2x3-records.js';
import { holdsValue, withoutComments } from './step-comment-skip.js';
import { referencesAnyExpressId } from './step-ref-scan.js';
import { isSubtype, slotRef, type SourceRecords, type StructuralRewrite } from './schema-converter-structural-source.js';
import { constantAction } from './schema-structural-varying-constant.js';

/**
 * IFC2X3's varying actions and the IFC4 actions they become. IFC4 dropped
 * IfcStructuralLinearActionVarying and IfcStructuralPlanarActionVarying
 * (IFC2X3_TC1.exp:7312, :7427). It holds several load values as an
 * IfcStructuralCurveAction or IfcStructuralSurfaceAction whose AppliedLoad is an
 * IfcStructuralLoadConfiguration (IFC4_ADD2_TC1.exp:9399, :9625, :9470).
 * `first` is what the IFC2X3 supertype's WR61 admits as AppliedLoad
 * (IFC2X3_TC1.exp:7301 and IfcStructuralPlanarAction); both directions take
 * only loads that all share one of those types. `min` is the size of
 * VaryingAppliedLoads (LIST [2:?] linear, [3:?] planar). `spread` is the IFC4
 * PredefinedTypes a downgrade takes: values at locations, linear in between
 * (IFC4_ADD2_TC1.exp:2308, :2330), which is what the IFC2X3 varying action holds.
 * SINUS, PARABOLA, DISCRETE, ISOCONTOUR and the rest keep their previous handling.
 */
const KINDS = [
  { ifc2x3: 'IFCSTRUCTURALLINEARACTIONVARYING', ifc4: 'IFCSTRUCTURALCURVEACTION', first: ['IFCSTRUCTURALLOADLINEARFORCE', 'IFCSTRUCTURALLOADTEMPERATURE'], min: 2, spread: ['.NOTDEFINED.', '.LINEAR.', '.POLYGONAL.'] },
  { ifc2x3: 'IFCSTRUCTURALPLANARACTIONVARYING', ifc4: 'IFCSTRUCTURALSURFACEACTION', first: ['IFCSTRUCTURALLOADPLANARFORCE', 'IFCSTRUCTURALLOADTEMPERATURE'], min: 3, spread: ['.NOTDEFINED.', '.BILINEAR.'] },
] as const;

/** Why the downgrade refuses a file: a record it does not convert names a configuration it converts, or a record it passes through as it is names any configuration. */
export const SHARED_CONFIGURATION = 'IFCSTRUCTURALLOADCONFIGURATION shared with a non-converted referrer has no representation in IFC2X3';

const FROM_IFC2X3 = 'an IFC2X3 varying action is written as an IFC4 curve or surface action with PredefinedType NOTDEFINED and an IfcStructuralLoadConfiguration holding its loads without Locations; the IfcShapeAspect of its representation keeps the locations';
const TO_IFC2X3 = 'an IFC4 curve or surface action with an IfcStructuralLoadConfiguration is written as an IFC2X3 varying action, its locations taken from the one IfcShapeAspect of its representation; the configuration Name, Locations and the action PredefinedType have no slot in IFC2X3';

type Kind = (typeof KINDS)[number];

/** The IFC4 action an IFC2X3 varying action converts to. */
export const varyingTarget = (ifc2x3: string): string | undefined => KINDS.find((k) => k.ifc2x3 === ifc2x3)?.ifc4;

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
  private effectiveTypes: ReadonlyMap<number, string> | undefined;
  private source?: SourceRecords;
  /** IFC4 IfcStructuralLoadConfiguration id -> its values. */
  private readonly configs = new Map<number, number[]>();
  /** IfcProductDefinitionShape id -> the IfcShapeAspects naming it as PartOfProductDefinitionShape. */
  private readonly aspects = new Map<number, { id: number; representations: number }[]>();

  fromSource(source: SourceRecords, from: string, to: string): void {
    const mode = from === 'IFC2X3' && to === 'IFC4' ? 'upgrade' : from === 'IFC4' && to === 'IFC2X3' ? 'downgrade' : null;
    const present = (types: readonly string[]) => types.some((type) => source.ids(type).length > 0);
    const work = mode === 'upgrade' ? present(KINDS.map((k) => k.ifc2x3))
      // With no action to convert, a downgrade still checks what names a configuration.
      : mode === 'downgrade' && present(['IFCSTRUCTURALLOADCONFIGURATION']);
    if (!work) return;
    this.readAspects(source.ids('IFCSHAPEASPECT'), (id) => source.slots(id));
    for (const id of mode === 'downgrade' ? source.ids('IFCSTRUCTURALLOADCONFIGURATION') : []) {
      const values = listItems(source.slots(id)?.[1] ?? '')?.map(refId);
      if (values?.length && values.every((v) => v !== null)) this.configs.set(id, values as number[]);
    }
    this.mode = mode;
    this.source = source;
    if (mode === 'downgrade') this.checkSharedConfigurations(source);
  }

  /** Prepare the same upgrade using the records a filtered or edited export actually writes. */
  fromEffective(types: ReadonlyMap<number, string>, aspects: readonly number[], slots: (id: number) => readonly string[] | undefined): void {
    this.mode = 'upgrade';
    this.effectiveTypes = types;
    this.readAspects(aspects, slots);
  }

  private readAspects(ids: readonly number[], slots: (id: number) => readonly string[] | undefined): void {
    for (const id of ids) {
      const args = slots(id);
      const shape = refId(args?.[4]);
      if (shape === null) continue;
      const list = this.aspects.get(shape) ?? [];
      list.push({ id, representations: listItems(args?.[0] ?? '')?.length ?? -1 });
      this.aspects.set(shape, list);
    }
  }

  /** Rust scan_ifc4 keeps configurations referenced by any record that is not converted.
   * They have no IFC2X3 form, so refuse the export instead of silently proxying a referrer.
   */
  private checkSharedConfigurations(source: SourceRecords): void {
    const candidates = new Set<number>();
    const consumed = new Set<number>();
    const configs = new Set(this.configs.keys());
    for (const { ifc4 } of KINDS) {
      for (const id of source.ids(ifc4)) {
        const args = source.slots(id);
        if (!args || args.some((a, i) => i !== 7 && referencesAnyExpressId(a, configs))) continue;
        if (this.toIfc2x3(id, ifc4, args)) {
          candidates.add(id);
          consumed.add(refId(args[7])!);
        }
      }
    }
    for (const { id } of source.naming(consumed)) {
      if (!candidates.has(id)) throw new Error(SHARED_CONFIGURATION);
    }
  }

  private typeOf(id: number | null): string {
    return id === null ? '' : this.effectiveTypes?.get(id) ?? this.source?.type(id) ?? '';
  }

  /** The target record body for a varying action of either schema, or undefined. */
  rewrite(id: number, entity: string, args: readonly string[], carried: ReadonlySet<string>): StructuralRewrite | undefined {
    return this.mode === 'upgrade' ? this.toIfc4(entity, args, carried) : this.mode === 'downgrade' ? this.toIfc2x3(id, entity, args) : undefined;
  }

  /** IfcStructuralLoadConfiguration records written so far, to append after the source records. */
  added(): string[] { return this.pending.splice(0); }

  /**
   * The shape aspect locating `loads` when both schemas hold the action: the
   * one aspect of its representation (and `location`, when IFC2X3 names one),
   * enough loads, all of one type that the IFC2X3 WR61 admits.
   */
  private convertible(kind: Kind, representation: string, loads: readonly (number | null)[], location?: number | null): number | undefined {
    const found = this.aspects.get(slotRef(representation) ?? -1);
    if (found?.length !== 1 || (location !== undefined && found[0].id !== location) || loads.length < kind.min || found[0].representations !== loads.length) return undefined;
    const type = this.typeOf(loads[0]);
    const first: readonly string[] = kind.first;
    return first.includes(type) && loads.every((l) => this.typeOf(l) === type) ? found[0].id : undefined;
  }

  /**
   * IFC2X3 -> IFC4, when this prepass is armed: whether this IFC2X3 varying
   * action stays unconverted (no IFC4 entity holds it then). Every record of the
   * 14 attributes IFC2X3 gives it is written, as a configuration or as a constant
   * action (`constant`), so only a malformed one stays. False when unarmed.
   */
  staysUnconverted(entity: string, args: readonly string[]): boolean {
    return this.upgrading && KINDS.some((k) => k.ifc2x3 === entity) && args.length !== 14;
  }

  /**
   * The constant IFC4 action for a varying action no configuration holds (#11037,
   * #11354): its initial load and PredefinedType CONST. Undefined unless the
   * record is an IFC2X3 varying action of 14 attributes.
   */
  constant(entity: string, args: readonly string[], carried: ReadonlySet<string>): StructuralRewrite | undefined {
    const target = varyingTarget(entity);
    if (!target || args.length !== 14) return undefined;
    return constantAction(target, entity, args, this.namesLoad(args), carried.has('CausedBy'));
  }

  /** Whether AppliedLoad names a record IFC4 counts as an IfcStructuralLoad. */
  private namesLoad(args: readonly string[]): boolean {
    return isSubtype('IFC4', this.typeOf(slotRef(args[7])), 'IfcStructuralLoad');
  }

  /** Armed for IFC2X3 -> IFC4, with the exporter's id allocator. */
  private get upgrading(): boolean { return this.mode === 'upgrade' && !!this.ids; }

  /** The kind and loads of an IFC2X3 varying action `toIfc4` converts, or undefined. */
  private upgradeLoads(entity: string, args: readonly string[]): { kind: Kind; loads: (number | null)[] } | undefined {
    const kind = KINDS.find((k) => k.ifc2x3 === entity);
    if (!this.upgrading || !kind || args.length !== 14) return undefined;
    // Comment-aware, as the constant fallback reads AppliedLoad: a commented reference must not fall back (#11354).
    const loads = [args[7], ...(listItems(args[13]) ?? [])].map(slotRef);
    return this.convertible(kind, args[6], loads, slotRef(args[12])) === undefined ? undefined : { kind, loads };
  }

  private toIfc4(entity: string, args: readonly string[], carried: ReadonlySet<string>): StructuralRewrite | undefined {
    const found = this.upgradeLoads(entity, args);
    if (!found) return this.upgrading ? this.constant(entity, args, carried) : undefined;
    const { kind, loads } = found;
    const id = this.ids!();
    this.pending.push(`#${id}=IFCSTRUCTURALLOADCONFIGURATION($,(${loads.map((l) => `#${l}`).join(',')}),$);`);
    const losses = [FROM_IFC2X3];
    // A CausedBy IFC4 holds as a 'Causes' relationship (`StructuralCarriers.noteCause`) is not lost.
    if (holdsValue(args[10]) && !carried.has('CausedBy')) losses.push(`${entity}.CausedBy has no slot in IFC4; its value is omitted`);
    return { body: `${kind.ifc4}(${[...args.slice(0, 7), `#${id}`, args[8], args[9], args[11], '.NOTDEFINED.'].join(',')})`, losses };
  }

  private toIfc2x3(id: number, entity: string, args: readonly string[]): StructuralRewrite | undefined {
    const kind = KINDS.find((k) => k.ifc4 === entity);
    if (!kind || args.length !== 12) return undefined;
    const predefined = args[11].trim().toUpperCase();
    if (!(kind.spread as readonly string[]).includes(predefined)) return undefined;
    const config = refId(args[7]) ?? -1;
    const values = this.configs.get(config);
    if (!values) return undefined;
    const aspect = this.convertible(kind, args[6], values);
    if (aspect === undefined) return undefined;
    const [first, ...rest] = values.map((v) => `#${v}`);
    // `inspect` reports this for the records it sees; a rewritten one skips it.
    const losses = [TO_IFC2X3, ...(withoutComments(args[9]) === '$' ? [destabilizingUnknown(entity)] : [])];
    // The upgrade writes the same loads and PredefinedType NOTDEFINED (`toIfc4`).
    const restored = [[config, ['Values']] as const, ...(predefined === '.NOTDEFINED.' ? [[id, ['PredefinedType']] as const] : [])];
    return { body: `${kind.ifc2x3}(${[...args.slice(0, 7), first, args[8], args[9], '$', args[10], `#${aspect}`, `(${rest.join(',')})`].join(',')})`, losses, restored };
  }
}
