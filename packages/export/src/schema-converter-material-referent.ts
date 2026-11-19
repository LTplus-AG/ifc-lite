/* SPDX-License-Identifier: MPL-2.0 */
/**
 * The `Material` a downgraded IfcMaterialProperties may name (#10763).
 *
 * IFC4 types `IfcMaterialProperties.Material` as any IfcMaterialDefinition
 * (a material, a layer, a layer/profile/constituent set or member); IFC2X3
 * `IfcExtendedMaterialProperties.Material` takes an IfcMaterial only. So the
 * downgrade cannot carry the reference by value:
 *  - an IfcMaterial is kept;
 *  - a definition whose `Material`, or whose members' `Material`, is exactly
 *    one IfcMaterial is pointed at that material;
 *  - anything else, the record is not written (`apply` returns null) and the
 *    export and the loss report name it.
 * Attributes are found by name in the source schema, so subtypes such as
 * IfcMaterialLayerWithOffsets resolve too. Twin of Rust
 * `schema_material_referent.rs`. Both resolve the record as the writer hands
 * it over (edited, created), before conversion, against the records the
 * export writes: the single, subset and merged paths each build their
 * `MaterialSource` from what they write.
 */
import { attrNameTable, type IfcSchemaVersion } from './schema-converter.js';
import { listItems } from './schema-converter-structural-axes.js';
import { SourceRecords, slotRef, slotUnset, type SourceStore } from './schema-converter-structural-source.js';
import { readStepSlots } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';

/** The member lists of the IFC4 material sets. */
const MEMBERS = ['MaterialLayers', 'MaterialProfiles', 'MaterialConstituents'];
const PROPERTIES = 'IFCMATERIALPROPERTIES';
/** A lookup that knows no record. */
const NOTHING: MaterialSource = { typeOf: () => undefined, slots: () => undefined };

/**
 * The records the export writes, by id in the line's id space: the effective
 * model in an export (edits, overlay-created records, retypes and deletions
 * applied), a merged model's under its offset, the source in a report.
 */
export interface MaterialSource {
  /** The UPPERCASE type of a record the export writes; undefined for one it does not. */
  typeOf(id: number): string | undefined;
  /** Its slots as written. */
  slots(id: number): readonly string[] | undefined;
}

export class MaterialReferents {
  /** Record id -> the type its `Material` names, for records not written. */
  private readonly dropped = new Map<number, string>();

  /** The export's record lookup. Without one nothing resolves, so every downgraded record is left out and reported: never carried unchecked. */
  constructor(private source: MaterialSource = NOTHING) {}

  /** The merged exporter's next model: its records, in the merge's id space. */
  rearm(source: MaterialSource): void {
    this.source = source;
  }

  /** The IfcMaterial `id` resolves to, in a `from` record, or null. A set member the export does not write is left out of the set, as the writers leave it out of the list. */
  resolve(id: number, from: string): number | null {
    const source = this.source, table = attrNameTable(from as IfcSchemaVersion);
    const type = source.typeOf(id);
    if (!type) return null;
    if (type === 'IFCMATERIAL') return id;
    const names = table?.get(type), slots = source.slots(id);
    if (!names || !slots) return null;
    const material = (slot: string | undefined) => {
      const ref = slotRef(slot);
      return ref !== null && source.typeOf(ref) === 'IFCMATERIAL' ? ref : null;
    };
    if (names.includes('Material')) return material(slots[names.indexOf('Material')]);
    const at = names.findIndex((n) => MEMBERS.includes(n));
    if (at < 0) return null;
    const found = new Set<number>();
    for (const member of listItems(slots[at]) ?? []) {
      const ref = slotRef(member);
      if (ref === null) return null;
      const memberType = source.typeOf(ref);
      if (memberType === undefined) continue;
      const memberSlots = source.slots(ref);
      const m = table?.get(memberType)?.indexOf('Material') ?? -1;
      if (m < 0 || !memberSlots) return null;
      // A member without a material (an air gap) names none.
      if (slotUnset(memberSlots[m])) continue;
      const named = material(memberSlots[m]);
      if (named === null) return null;
      found.add(named);
    }
    return found.size === 1 ? [...found][0] : null;
  }

  /**
   * `line`, a source-schema record before conversion, its IfcMaterialProperties
   * `Material` naming the one IfcMaterial it resolves to; null when none, so the
   * record is not written. Resolved before conversion, so a reference the
   * converter withholds (an IFC4-only set) is replaced first.
   */
  apply(line: string, from: string, to: string): string | null {
    const head = to === 'IFC2X3' && (from === 'IFC4' || from === 'IFC4X3') ? stepRecordHead(line) : null;
    // A length check first, so most records never build an upper-case copy.
    if (!head || head.typeEnd - head.typeStart !== PROPERTIES.length || line.slice(head.typeStart, head.typeEnd).toUpperCase() !== PROPERTIES) return line;
    const at = attrNameTable(from as IfcSchemaVersion)?.get(PROPERTIES)?.indexOf('Material') ?? -1;
    const record = at < 0 ? null : readStepSlots(line);
    if (!record) return line;
    const named = slotRef(record.slots[at]);
    const material = named === null ? null : this.resolve(named, from);
    if (material !== null) {
      if (material === named) return line;
      const slots = [...record.slots];
      slots[at] = `#${material}`;
      return `${record.prefix}${slots.join(',')}${record.suffix}`;
    }
    // Named as Rust names it: a material record by its type, anything else as unread.
    const type = named === null ? undefined : this.source.typeOf(named);
    const id = /#\s*(\d+)/.exec(line.slice(0, head.eq))?.[1];
    if (id !== undefined) this.dropped.set(Number(id), type?.startsWith('IFCMATERIAL') ? type : 'an unread record');
    return null;
  }

  /** Whether `apply` left record `id` out. */
  leftOut(id: number): boolean { return this.dropped.has(id); }

  warnings(): string[] {
    if (!this.dropped.size) return [];
    const sites = [...this.dropped].sort(([a], [b]) => a - b).map(([id, type]) => `#${id} (${type})`);
    return [`${this.dropped.size} IfcMaterialProperties record(s) were not written: IFC2X3 IfcExtendedMaterialProperties.Material must name one IfcMaterial, and theirs does not: ${sites.join(', ')} (#10763).`];
  }
}

/**
 * The IfcMaterialProperties records of `store` an IFC4/IFC4X3 -> IFC2X3
 * export leaves out, with their attribute names, for the loss report.
 */
export function materialPropertiesNotWritten(store: SourceStore, from: string, to: string): { ids: number[]; attributes: readonly string[] } {
  const source = new SourceRecords(store);
  const referents = new MaterialReferents({ typeOf: (id) => source.type(id), slots: (id) => source.slots(id) });
  const attributes = attrNameTable(from as IfcSchemaVersion)?.get('IFCMATERIALPROPERTIES') ?? [];
  const at = attributes.indexOf('Material');
  if (to !== 'IFC2X3' || at < 0) return { ids: [], attributes };
  const ids = source.ids('IFCMATERIALPROPERTIES').filter((id) => {
    const named = slotRef(source.slots(id)?.[at]);
    return named === null || referents.resolve(named, from) === null;
  });
  return { ids, attributes };
}

/**
 * A merged model's material records in the merge's id space: its `written`
 * local ids under `offset`, their text remapped by `remap` as the merge
 * remaps it. Material records are never shared infrastructure, so a record's
 * merged id is its local id plus the offset.
 */
export function mergedMaterialSource(store: SourceStore, written: (id: number) => boolean, offset: number, remap: (text: string) => string): MaterialSource {
  const source = new SourceRecords(store);
  const local = (id: number) => (id > offset && written(id - offset) ? id - offset : null);
  return {
    typeOf: (id) => { const l = local(id); return l === null ? undefined : source.type(l); },
    slots: (id) => {
      const l = local(id), text = l === null ? undefined : source.text(l);
      return text === undefined ? undefined : readStepSlots(remap(text))?.slots;
    },
  };
}
