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
import { readStepSlots, splitTopLevelStepArguments } from './step-argument-parser.js';
import { frameArgs, stepRecordFrame, stepRecordHead, withFrameArgs } from './step-record-frame.js';
import { remapEntityText } from './merged-remap.js';

/** The member lists of the IFC4 material sets. */
const MEMBERS = ['MaterialLayers', 'MaterialProfiles', 'MaterialConstituents'];
const PROPERTIES = 'IFCMATERIALPROPERTIES';
/** A lookup that knows no record. */
const NOTHING: MaterialSource = { typeOf: () => undefined, slots: () => undefined };

/** Whether a `from` -> `to` export downgrades IfcMaterialProperties: the one rule the writers and the report share. */
export const downgradesMaterial = (from: string, to: string): boolean => to === 'IFC2X3' && (from === 'IFC4' || from === 'IFC4X3');

/**
 * The records the export writes, by id in the line's id space: the effective
 * model in an export (edits, overlay-created records, retypes and deletions
 * applied), a merged model's under its offset, the source in a report.
 */
export interface MaterialSource {
  /** The UPPERCASE type of a record the export writes; undefined for one it does not. */
  typeOf(id: number): string | undefined;
  /** Its slots as written; undefined for a record the export does not write or could not read. */
  slots(id: number): readonly string[] | undefined;
}

export class MaterialReferents {
  /** Record id -> why it was not written: the type its `Material` names, or `unreadable` / `no Material` / `an unread record`. */
  private readonly dropped = new Map<number, string>();

  /** The export's record lookup. Without one nothing resolves, so every downgraded record is left out and reported: never carried unchecked. */
  constructor(private source: MaterialSource = NOTHING) {}

  /** The merged exporter's next model: its records, in the merge's id space. */
  rearm(source: MaterialSource): void {
    this.source = source;
  }

  /** The IfcMaterial `id` resolves to, in a `from` record, or null. A set member the export does not write is left out of the set, as the writers leave it out of the list. */
  resolve(id: number, from: string): number | null {
    const source = this.source, type = source.typeOf(id);
    if (!type) return null;
    if (type === 'IFCMATERIAL') return id;
    const table = attrNameTable(from as IfcSchemaVersion), names = table?.get(type), slots = source.slots(id);
    if (!names || !slots) return null;
    const material = (slot: string | undefined) => {
      const ref = slotRef(slot);
      return ref !== null && source.typeOf(ref) === 'IFCMATERIAL' ? ref : null;
    };
    const own = names.indexOf('Material');
    if (own >= 0) return material(slots[own]);
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
    const head = downgradesMaterial(from, to) ? stepRecordHead(line) : null;
    // A length check first, so most records never build an upper-case copy.
    if (!head || head.typeEnd - head.typeStart !== PROPERTIES.length || line.slice(head.typeStart, head.typeEnd).toUpperCase() !== PROPERTIES) return line;
    const at = attrNameTable(from as IfcSchemaVersion)?.get(PROPERTIES)?.indexOf('Material') ?? -1;
    if (at < 0) return line;
    // Framed as `convertRecord` frames it, which also accepts a record without its ';'.
    // A record that cannot be read is not checked, so it is left out too.
    const frame = stepRecordFrame(line, { allowMissingSemicolon: true });
    const slots = frame ? splitTopLevelStepArguments(frameArgs(line, frame)) : null;
    const named = slotRef(slots?.[at]);
    const material = named === null ? null : this.resolve(named, from);
    if (frame && slots && material !== null) { // `frame && slots` only narrows: unread, no material
      if (material === named) return line;
      const out = [...slots];
      out[at] = `#${material}`;
      return withFrameArgs(line, frame, out.join(','));
    }
    // Named as Rust names it: the record unreadable, without a Material, or by its referent.
    const why = !slots ? 'unreadable' : named === null ? 'no Material' : this.referentName(named);
    const id = slotRef(line.slice(0, head.eq)); // past a leading comment, as the head is read
    if (id !== null) this.dropped.set(id, why);
    return null;
  }

  /** A referent by its material type when it could be read; one that could not is named so, not blamed for its materials. */
  private referentName(id: number): string {
    const type = this.source.typeOf(id);
    return type?.startsWith('IFCMATERIAL') && this.source.slots(id) ? type : 'an unread record';
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
export function materialPropertiesNotWritten(store: Pick<SourceStore, 'entityIndex'> & Partial<Pick<SourceStore, 'source'>>, from: string, to: string): { ids: number[]; attributes: readonly string[] } {
  const attributes = attrNameTable(from as IfcSchemaVersion)?.get(PROPERTIES) ?? [];
  // As `apply`: no downgrade, or no Material to check, writes each one.
  if (!downgradesMaterial(from, to) || !attributes.includes('Material')) return { ids: [], attributes };
  const { entityIndex, source: bytes } = store;
  // @raw-entity-enumeration-ok this report reads a parsed source's own index, not a live view
  const all = entityIndex.byType.get(PROPERTIES) ?? [];
  // Without the bytes (none, or a sourceless store's empty buffer) no record can be checked: the report is
  // pessimistic and names each, as a bare `convertStepLine` leaves each out. An export needs the bytes.
  if (!bytes?.byteLength) return { ids: [...all], attributes };
  // The writer's own decision for the source as parsed: each record through the `apply` the export runs.
  const source = new SourceRecords({ entityIndex, source: bytes });
  const referents = new MaterialReferents({ typeOf: (id) => source.type(id), slots: (id) => source.slots(id) });
  return { ids: all.filter((id) => { const text = source.text(id); return text === undefined || referents.apply(text, from, to) === null; }), attributes };
}

/**
 * Arms `materials` with a merged model's records (#10763) and returns the
 * model's `written` predicate, for the merge loop: its `written` local ids
 * under `offset`, their text remapped as the merge remaps it. Material records
 * are never shared infrastructure, so a merged id is the local id plus the offset.
 */
export function armMergedModel(materials: MaterialReferents, store: SourceStore, written: (id: number) => boolean, offset: number, sharedRemap: ReadonlyMap<number, number>): (id: number) => boolean {
  const source = new SourceRecords(store);
  const local = (id: number) => (id > offset && written(id - offset) ? id - offset : null);
  const read = new Map<number, readonly string[] | undefined>();
  materials.rearm({
    typeOf: (id) => { const l = local(id); return l === null ? undefined : source.type(l); },
    slots: (id) => {
      if (!read.has(id)) {
        const l = local(id), text = l === null ? undefined : source.text(l);
        read.set(id, text === undefined ? undefined : readStepSlots(remapEntityText(text, offset, sharedRemap))?.slots);
      }
      return read.get(id);
    },
  });
  return written;
}
