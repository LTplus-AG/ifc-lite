/* SPDX-License-Identifier: MPL-2.0 */
/**
 * An IfcRelSpaceBoundary that names no element, on an IFC2X3 upgrade.
 *
 * IFC2X3 declares `RelatedBuildingElement` OPTIONAL, and a VIRTUAL boundary
 * (a space limit with nothing physical behind it) leaves it `$`. IFC4 and
 * IFC4X3 declare it MANDATORY, and their `CorrectPhysOrVirt` rule wants an
 * IfcVirtualElement (or IfcOpeningElement) behind a VIRTUAL boundary. Neither
 * a `$` nor a demotion to .NOTDEFINED can satisfy that, and the converter
 * invents no entity or reference, so the boundary is not written and the export
 * and the loss report name it. A boundary that names an element is untouched.
 * Twin of Rust `schema_space_boundary.rs`.
 */
import { attrNameTable, type IfcSchemaVersion } from './schema-converter.js';
import { SourceRecords, slotRef, type SourceStore } from './schema-converter-structural-source.js';
import { holdsValue } from './step-comment-skip.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { frameArgs, stepRecordFrame, stepRecordHead } from './step-record-frame.js';

const BOUNDARY = 'IFCRELSPACEBOUNDARY';
const ELEMENT = 'RelatedBuildingElement';

/** Whether a `from` -> `to` export upgrades IfcRelSpaceBoundary to a schema that requires its element. */
export const requiresBoundaryElement = (from: string, to: string): boolean =>
  from === 'IFC2X3' && (to === 'IFC4' || to === 'IFC4X3');

/** True when `line`, a source-schema record, is an IfcRelSpaceBoundary whose RelatedBuildingElement is unset. A record that cannot be read, or whose arity is not IFC2X3's, is never judged. */
function unrelated(line: string, from: string): boolean {
  const head = stepRecordHead(line);
  // A length check first, so most records never build an upper-case copy.
  if (!head || head.typeEnd - head.typeStart !== BOUNDARY.length || line.slice(head.typeStart, head.typeEnd).toUpperCase() !== BOUNDARY) return false;
  const names = attrNameTable(from as IfcSchemaVersion)?.get(BOUNDARY);
  const at = names?.indexOf(ELEMENT) ?? -1;
  const frame = at < 0 ? null : stepRecordFrame(line, { allowMissingSemicolon: true });
  const slots = frame ? splitTopLevelStepArguments(frameArgs(line, frame)) : null;
  return slots !== null && slots.length === names!.length && !holdsValue(slots[at]);
}

export class SpaceBoundaryElements {
  private readonly dropped = new Set<number>();

  /** `line` unchanged, or null when it is a boundary the upgrade cannot write. */
  apply(line: string, from: string, to: string): string | null {
    if (!requiresBoundaryElement(from, to) || !unrelated(line, from)) return line;
    const head = stepRecordHead(line);
    const id = head ? slotRef(line.slice(0, head.eq)) : null;
    if (id !== null) this.dropped.add(id);
    return null;
  }

  /** Whether `apply` left record `id` out. */
  leftOut(id: number): boolean { return this.dropped.has(id); }

  /** The ids `apply` and `note` left out. */
  ids(): ReadonlySet<number> { return this.dropped; }

  /** Whether any record is left out: the gate the omitted-reference filter runs behind. */
  get any(): boolean { return this.dropped.size > 0; }

  /**
   * Record `ids` as left out BEFORE the records are converted, so a relationship
   * that precedes a boundary in the file is already scrubbed of it (#11457).
   * `apply` adds the same ids again at conversion, which changes nothing.
   */
  note(ids: Iterable<number>): void { for (const id of ids) this.dropped.add(id); }

  warnings(): string[] {
    if (!this.dropped.size) return [];
    const sites = [...this.dropped].sort((a, b) => a - b).map((id) => `#${id}`);
    return [`${this.dropped.size} IfcRelSpaceBoundary record(s) were not written: IFC4 requires RelatedBuildingElement and the source names none: ${sites.join(', ')}.`];
  }
}

/** The IfcRelSpaceBoundary records of `store` an IFC2X3 upgrade leaves out, with the attribute that is lost. */
export function spaceBoundariesNotWritten(store: Pick<SourceStore, 'entityIndex'> & Partial<Pick<SourceStore, 'source' | 'deferredEntityIndex'>>, from: string, to: string): number[] {
  if (!requiresBoundaryElement(from, to)) return [];
  const { entityIndex, deferredEntityIndex, source: bytes } = store;
  // Without the bytes nothing can be read, and the export (which needs them) judges each record.
  if (!bytes?.byteLength) return [];
  const source = new SourceRecords({ entityIndex, deferredEntityIndex, source: bytes });
  return source.ids(BOUNDARY).filter((id) => { const text = source.text(id); return text !== undefined && unrelated(text, from); });
}

/** The loss-report entry (none, or one) for the boundaries an IFC2X3 upgrade leaves out: IFC4 requires an element and none is invented. */
export function spaceBoundaryLoss(store: Parameters<typeof spaceBoundariesNotWritten>[0], from: string, to: string): Array<{ sourceType: string; targetType: string; kind: 'lossy'; droppedAttributes: string[]; count: number; expressIds: number[] }> {
  const expressIds = spaceBoundariesNotWritten(store, from, to);
  return expressIds.length ? [{ sourceType: BOUNDARY, targetType: BOUNDARY, kind: 'lossy', droppedAttributes: [ELEMENT], count: expressIds.length, expressIds }] : [];
}
