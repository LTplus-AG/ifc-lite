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
 * `schema_material_referent.rs`. Both read the record as converted, so an edited
 * `Material` is checked as written, and both read only referents the export writes:
 * here the effective model's, edits applied, and a created record by its type.
 */
import { attrNameTable, type IfcSchemaVersion } from './schema-converter.js';
import { listItems } from './schema-converter-structural-axes.js';
import { SourceRecords, slotRef, slotUnset, type SourceStore } from './schema-converter-structural-source.js';
import { readStepSlots } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';

/** The member lists of the IFC4 material sets. */
const MEMBERS = ['MaterialLayers', 'MaterialProfiles', 'MaterialConstituents'];
const TYPE = 'IFCEXTENDEDMATERIALPROPERTIES';

/** What a record's type and slots are, by id: the effective model in an export, the source in a report. */
export interface MaterialSource {
  typeOf(id: number): string | undefined;
  slots(id: number): readonly string[] | undefined;
}

export class MaterialReferents {
  private source: MaterialSource | null = null;
  private from: IfcSchemaVersion = 'IFC4';
  /** Record id -> the type its `Material` names, for records not written. */
  private readonly dropped = new Map<number, string>();

  /** Arms an IFC4/IFC4X3 -> IFC2X3 conversion; anything else stays unarmed. */
  arm(source: MaterialSource, from: string, to: string): void {
    if (to !== 'IFC2X3' || (from !== 'IFC4' && from !== 'IFC4X3')) return;
    this.source = source;
    this.from = from;
  }

  /** The IfcMaterial `id` resolves to, or null. */
  resolve(id: number): number | null {
    const source = this.source, table = attrNameTable(this.from);
    const type = source?.typeOf(id);
    if (!source || !type) return null;
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
      const memberType = ref === null ? undefined : source.typeOf(ref);
      const memberSlots = ref === null ? undefined : source.slots(ref);
      const m = memberType ? table?.get(memberType)?.indexOf('Material') ?? -1 : -1;
      if (m < 0 || !memberSlots) return null;
      // A member without a material (an air gap) names none.
      if (slotUnset(memberSlots[m])) continue;
      const named = material(memberSlots[m]);
      if (named === null) return null;
      found.add(named);
    }
    return found.size === 1 ? [...found][0] : null;
  }

  /** `line`, an IFC2X3 record, naming the material its `Material` resolves to; null when none. */
  apply(line: string): string | null {
    const head = this.source ? stepRecordHead(line) : null;
    // A length check first, so most records never build an upper-case copy.
    if (!head || head.typeEnd - head.typeStart !== TYPE.length || line.slice(head.typeStart, head.typeEnd).toUpperCase() !== TYPE) return line;
    const record = readStepSlots(line);
    if (!record) return line;
    const named = slotRef(record.slots[0]);
    const material = named === null ? null : this.resolve(named);
    if (material !== null) return material === named ? line : `${record.prefix}${[`#${material}`, ...record.slots.slice(1)].join(',')}${record.suffix}`;
    // Named as Rust names it: a material record by its type, anything else as unread.
    const type = named === null ? undefined : this.source!.typeOf(named);
    // The id sits before the `=`, comments and all; a record without one is still left out.
    const id = /#\s*(\d+)/.exec(line.slice(0, head.eq))?.[1];
    if (id !== undefined) this.dropped.set(Number(id), type?.startsWith('IFCMATERIAL') ? type : 'an unread record');
    return null;
  }

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
  const referents = new MaterialReferents();
  const source = new SourceRecords(store);
  referents.arm({ typeOf: (id) => source.type(id), slots: (id) => source.slots(id) }, from, to);
  const attributes = attrNameTable(from as IfcSchemaVersion)?.get('IFCMATERIALPROPERTIES') ?? [];
  const at = attributes.indexOf('Material');
  if (to !== 'IFC2X3' || at < 0) return { ids: [], attributes };
  const ids = source.ids('IFCMATERIALPROPERTIES').filter((id) => {
    const named = slotRef(source.slots(id)?.[at]);
    return named === null || referents.resolve(named) === null;
  });
  return { ids, attributes };
}
