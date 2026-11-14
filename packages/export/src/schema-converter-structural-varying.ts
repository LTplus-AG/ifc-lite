/* SPDX-License-Identifier: MPL-2.0 */
/** Matches rust/export/src/schema_structural_varying.rs (#9668). */
import { getCanonicalEntityName, getSchemaRegistryForVersion, type IfcDataStore } from '@ifc-lite/parser';
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
 * (IFC2X3_TC1.exp:7301 and IfcStructuralPlanarAction). `min` is the size of
 * VaryingAppliedLoads (LIST [2:?] linear, [3:?] planar).
 */
const KINDS = [
  { ifc2x3: 'IFCSTRUCTURALLINEARACTIONVARYING', ifc4: 'IFCSTRUCTURALCURVEACTION', first: ['IFCSTRUCTURALLOADLINEARFORCE', 'IFCSTRUCTURALLOADTEMPERATURE'], min: 2 },
  { ifc2x3: 'IFCSTRUCTURALPLANARACTIONVARYING', ifc4: 'IFCSTRUCTURALSURFACEACTION', first: ['IFCSTRUCTURALLOADPLANARFORCE', 'IFCSTRUCTURALLOADTEMPERATURE'], min: 3 },
] as const;

const FROM_IFC2X3 = 'an IFC2X3 varying action is written as an IFC4 curve or surface action with PredefinedType NOTDEFINED and an IfcStructuralLoadConfiguration holding its loads without Locations; its VaryingAppliedLoadLocation remains an IfcShapeAspect of the action representation';
const TO_IFC2X3 = 'an IFC4 curve or surface action with an IfcStructuralLoadConfiguration is written as an IFC2X3 varying action, its locations taken from the one IfcShapeAspect of its representation; the configuration Name, Locations and the action PredefinedType have no slot in IFC2X3';

export interface Rewrite { readonly body: string; readonly losses: readonly string[] }
interface Configuration { readonly values: readonly number[]; readonly first: string; readonly loads: boolean }

/**
 * Converts varying actions in both directions. Both directions need the source
 * store (IFC4 -> IFC2X3 reads the configuration and the shape aspect a record
 * points at) or a fresh express id (IFC2X3 -> IFC4 writes a configuration), so
 * only an unedited full export arms it.
 */
export class StructuralVarying {
  private upgrade = false;
  /** The exporter's express-id allocator, shared with every other record it appends. */
  ids: (() => number) | null = null;
  private readonly pending: string[] = [];
  private configs: Map<number, Configuration> | null = null;
  /** IfcProductDefinitionShape id -> the IfcShapeAspects naming it as PartOfProductDefinitionShape. */
  private readonly aspects = new Map<number, number[]>();

  fromStore(store: IfcDataStore, from: string, to: string): void {
    if (from === 'IFC2X3' && to === 'IFC4') { this.upgrade = true; return; }
    if (from !== 'IFC4' || to !== 'IFC2X3') return;
    // @raw-entity-enumeration-ok conversion prepass is enabled only for an unedited full-source export
    const { byId, byType } = store.entityIndex;
    const slots = (id: number) => {
      const entry = byId.get(id);
      return entry ? readStepSlots(decodeRange(store.source, entry.byteOffset, entry.byteOffset + entry.byteLength))?.slots : undefined;
    };
    const typeOf = (id: number) => byId.get(id)?.type.toUpperCase() ?? '';
    for (const id of byType.get('IFCSHAPEASPECT') ?? []) {
      const shape = refId(slots(id)?.[4]);
      if (shape !== null) this.aspects.set(shape, [...(this.aspects.get(shape) ?? []), id]);
    }
    this.configs = new Map();
    for (const id of byType.get('IFCSTRUCTURALLOADCONFIGURATION') ?? []) {
      const values = listItems(slots(id)?.[1] ?? '')?.map(refId);
      if (!values?.length || values.some((v) => v === null)) continue;
      const refs = values as number[];
      this.configs.set(id, { values: refs, first: typeOf(refs[0]), loads: refs.every((v) => isIfc2x3Load(typeOf(v))) });
    }
  }

  /** The target record body for a varying action of either schema, or undefined. */
  rewrite(entity: string, args: readonly string[]): Rewrite | undefined {
    return this.upgrade ? this.toIfc4(entity, args) : this.toIfc2x3(entity, args);
  }

  /** IfcStructuralLoadConfiguration records written so far, to append after the source records. */
  added(): string[] { return this.pending.splice(0); }

  private toIfc4(entity: string, args: readonly string[]): Rewrite | undefined {
    const kind = KINDS.find((k) => k.ifc2x3 === entity);
    const loads = [args[7], ...(listItems(args[13] ?? '') ?? [])].map(refId);
    if (!kind || !this.ids || args.length !== 14 || loads.length < kind.min || loads.some((l) => l === null)) return undefined;
    const id = this.ids();
    this.pending.push(`#${id}=IFCSTRUCTURALLOADCONFIGURATION($,(${loads.map((l) => `#${l}`).join(',')}),$);`);
    const losses = [FROM_IFC2X3];
    if (args[10].trim() !== '$') losses.push(`${entity}.CausedBy has no slot in IFC4; its value is omitted`);
    return { body: `${kind.ifc4}(${[...args.slice(0, 7), `#${id}`, args[8], args[9], args[11], '.NOTDEFINED.'].join(',')})`, losses };
  }

  private toIfc2x3(entity: string, args: readonly string[]): Rewrite | undefined {
    const kind = KINDS.find((k) => k.ifc4 === entity);
    if (!kind || !this.configs || args.length !== 12 || args[11].trim().toUpperCase() === '.CONST.') return undefined;
    const config = this.configs.get(refId(args[7]) ?? -1);
    const aspects = this.aspects.get(refId(args[6]) ?? -1);
    if (!config?.loads || config.values.length < kind.min || !(kind.first as readonly string[]).includes(config.first) || aspects?.length !== 1) return undefined;
    const [first, ...rest] = config.values.map((v) => `#${v}`);
    return { body: `${kind.ifc2x3}(${[...args.slice(0, 7), first, args[8], args[9], '$', args[10], `#${aspects[0]}`, `(${rest.join(',')})`].join(',')})`, losses: [TO_IFC2X3] };
  }
}

/** Whether IFC4 `keyword` is an IfcStructuralLoad that IFC2X3 also has. */
function isIfc2x3Load(keyword: string): boolean {
  const registry = getSchemaRegistryForVersion('IFC2X3');
  const name = getCanonicalEntityName(registry, keyword);
  return !!name && registry.entities[name]?.inheritanceChain?.includes('IfcStructuralLoad') === true;
}
