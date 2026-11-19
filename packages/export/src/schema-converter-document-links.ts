/* SPDX-License-Identifier: MPL-2.0 */
/**
 * IfcDocumentInformation <-> IfcDocumentReference: the link IFC4 moved to the
 * other record (#10846). IFC2X3 lists a document's references in
 * `IfcDocumentInformation.DocumentReferences`; IFC4 made that an inverse and
 * points each reference at its document with
 * `IfcDocumentReference.ReferencedDocument`. A line converter can only write
 * `$` for the slot on the other record, so this prepass reads the links from
 * the source and `apply` writes them: on an upgrade, ReferencedDocument on
 * each listed reference; on a downgrade, DocumentReferences on each document
 * a reference names.
 *
 * IFC2X3 lets one document list a reference (`ReferenceToDocument : SET
 * [0:1]`), so a reference listed again keeps its first document and the
 * extra listing is reported. Types come from the source, so only an unedited
 * full export arms it. Twin of Rust `schema_document_links.rs`.
 */
import { attrNameTable, type IfcSchemaVersion } from './schema-converter.js';
import { listItems } from './schema-converter-structural-axes.js';
import { slotRef, slotUnset, type SourceRecords } from './schema-converter-structural-source.js';
import { readStepSlots } from './step-argument-parser.js';

const DOC = 'IFCDOCUMENTINFORMATION';
const REF = 'IFCDOCUMENTREFERENCE';
const ifc4Like = (s: string) => s === 'IFC4' || s === 'IFC4X3';

/** Whether a conversion between the schemas can move the link. */
export const documentLinksApply = (from: string, to: string): boolean =>
  (from === 'IFC2X3' && ifc4Like(to)) || (to === 'IFC2X3' && ifc4Like(from));

export class DocumentLinks {
  /** The index of the link slot in the converted record; -1 until armed. */
  private at = -1;
  /** Converted record id -> the value its link slot takes. */
  private readonly fill = new Map<number, string>();
  /** Source records whose link attribute this writes on the other side, by that attribute (the loss report). */
  readonly restored = new Map<number, ReadonlySet<string>>();
  private listedAgain = 0;

  fromSource(source: SourceRecords, from: string, to: string): void {
    if (!documentLinksApply(from, to)) return;
    const names = (schema: string, type: string) => attrNameTable(schema as IfcSchemaVersion)?.get(type);
    const up = from === 'IFC2X3';
    // The side that holds the link in the source, its slot, and the slot it moves to.
    const [holder, target] = up ? [DOC, REF] : [REF, DOC];
    const readAt = names(from, holder)?.indexOf(up ? 'DocumentReferences' : 'ReferencedDocument') ?? -1;
    const at = names(to, target)?.indexOf(up ? 'ReferencedDocument' : 'DocumentReferences') ?? -1;
    if (readAt < 0 || at < 0) return;
    const targets = new Set(source.ids(target));
    // A holder whose slot count is not the source schema's is not read.
    const holders = source.ids(holder).flatMap((id) => {
      const slots = source.slots(id);
      return slots && slots.length === names(from, holder)!.length ? [{ id, link: slots[readAt] }] : [];
    });
    const link = new Set([up ? 'DocumentReferences' : 'ReferencedDocument']);
    if (up) {
      for (const { id: doc, link: listed } of holders) {
        const members = listItems(listed) ?? [];
        let whole = members.length > 0;
        for (const member of members) {
          const ref = slotRef(member);
          const first = ref === null ? undefined : this.fill.get(ref);
          if (ref === null || !targets.has(ref)) whole = false;
          else if (first === undefined) this.fill.set(ref, `#${doc}`);
          // A repeat inside one list is not a second document.
          else if (first !== `#${doc}`) { this.listedAgain++; whole = false; }
        }
        if (whole) this.restored.set(doc, link);
      }
    } else {
      const lists = new Map<number, string[]>();
      for (const { id: ref, link: named } of holders) {
        const doc = slotRef(named);
        if (doc === null || !targets.has(doc)) continue;
        this.restored.set(ref, link);
        const list = lists.get(doc) ?? [];
        list.push(`#${ref}`);
        lists.set(doc, list);
      }
      for (const [doc, members] of lists) this.fill.set(doc, `(${members.join(',')})`);
    }
    if (this.fill.size > 0) this.at = at;
  }

  /** `line`, already converted, with its link slot written. */
  apply(line: string): string {
    if (this.at < 0) return line;
    const value = this.fill.get(Number(/^\s*#(\d+)/.exec(line)?.[1]));
    const record = value ? readStepSlots(line) : null;
    if (!record || !slotUnset(record.slots[this.at])) return line;
    const slots = [...record.slots];
    slots[this.at] = value!;
    return `${record.prefix}${slots.join(',')}${record.suffix}`;
  }

  warnings(): string[] {
    return this.listedAgain > 0
      ? [`${this.listedAgain} IfcDocumentReference listing(s) past a reference's first IfcDocumentInformation were dropped: IFC4 ReferencedDocument names one document (#10846).`]
      : [];
  }
}
