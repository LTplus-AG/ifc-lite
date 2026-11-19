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
import { stepRecordHead } from './step-record-frame.js';

const DOC = 'IFCDOCUMENTINFORMATION';
const REF = 'IFCDOCUMENTREFERENCE';
const ifc4Like = (s: string) => s === 'IFC4' || s === 'IFC4X3';

/** Whether a conversion between the schemas can move the link. */
export const documentLinksApply = (from: string, to: string): boolean =>
  (from === 'IFC2X3' && ifc4Like(to)) || (to === 'IFC2X3' && ifc4Like(from));

export class DocumentLinks {
  /** The converted type and the index of its link slot. */
  private slot: { type: string; at: number } | null = null;
  /** Converted record id -> the value its link slot takes. */
  private readonly fill = new Map<number, string>();
  private listedAgain = 0;

  fromSource(source: SourceRecords, from: string, to: string): void {
    if (!documentLinksApply(from, to)) return;
    const at = (schema: string, type: string, name: string) => attrNameTable(schema as IfcSchemaVersion)?.get(type)?.indexOf(name) ?? -1;
    // A record whose slot count is not the source schema's is not read.
    const read = (type: string) => source.ids(type).flatMap((id) => {
      const slots = source.slots(id);
      return slots && slots.length === attrNameTable(from as IfcSchemaVersion)?.get(type)?.length ? [{ id, slots }] : [];
    });
    const refs = read(REF);
    const docs = read(DOC);
    const isRef = new Set(refs.map((r) => r.id)), isDoc = new Set(docs.map((d) => d.id));
    if (from === 'IFC2X3') {
      const listAt = at(from, DOC, 'DocumentReferences'), slotAt = at(to, REF, 'ReferencedDocument');
      if (listAt < 0 || slotAt < 0) return;
      this.slot = { type: REF, at: slotAt };
      for (const doc of docs) {
        for (const member of listItems(doc.slots[listAt]) ?? []) {
          const ref = slotRef(member);
          if (ref === null || !isRef.has(ref)) continue;
          if (this.fill.has(ref)) this.listedAgain++;
          else this.fill.set(ref, `#${doc.id}`);
        }
      }
    } else {
      const docAt = at(from, REF, 'ReferencedDocument'), slotAt = at(to, DOC, 'DocumentReferences');
      if (docAt < 0 || slotAt < 0) return;
      this.slot = { type: DOC, at: slotAt };
      const lists = new Map<number, string[]>();
      for (const ref of refs) {
        const doc = slotRef(ref.slots[docAt]);
        if (doc !== null && isDoc.has(doc)) lists.set(doc, [...(lists.get(doc) ?? []), `#${ref.id}`]);
      }
      for (const [doc, members] of lists) this.fill.set(doc, `(${members.join(',')})`);
    }
  }

  /** `line`, already converted, with its link slot written. */
  apply(line: string): string {
    const value = this.slot && this.fill.get(Number(/^\s*#(\d+)/.exec(line)?.[1]));
    if (!value || !this.slot) return line;
    const head = stepRecordHead(line);
    const record = head && line.slice(head.typeStart, head.typeEnd).toUpperCase() === this.slot.type ? readStepSlots(line) : null;
    if (!record || !slotUnset(record.slots[this.slot.at])) return line;
    const slots = [...record.slots];
    slots[this.slot.at] = value;
    return `${record.prefix}${slots.join(',')}${record.suffix}`;
  }

  warnings(): string[] {
    return this.listedAgain > 0
      ? [`${this.listedAgain} IfcDocumentReference listing(s) past a reference's first IfcDocumentInformation were dropped: IFC4 ReferencedDocument names one document (#10846).`]
      : [];
  }
}
