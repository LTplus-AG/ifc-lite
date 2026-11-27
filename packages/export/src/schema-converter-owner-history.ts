/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { withoutComments } from './step-comment-skip.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { isRootedType } from './merged-guid.js';

/** {@link isRootedType} per type name: `apply` asks once per converted line,
 *  and the inheritance walk allocates per step. */
const ROOTED_BY_TYPE = new Map<string, boolean>();

function isRooted(type: string): boolean {
  let rooted = ROOTED_BY_TYPE.get(type);
  if (rooted === undefined) {
    rooted = isRootedType(type);
    ROOTED_BY_TYPE.set(type, rooted);
  }
  return rooted;
}

/**
 * `IfcRoot.OwnerHistory` on a downgrade to IFC2X3 (#4686).
 *
 * OwnerHistory is OPTIONAL in IFC4 and IFC4X3 but MANDATORY in IFC2X3, so a
 * record the source wrote with `$` there is invalid once the header says
 * IFC2X3. The downgrade reuses an `IfcOwnerHistory` the export already writes;
 * it never invents one, because an owner history asserts who made the model
 * with which application and when, and the source did not say. When the
 * export keeps none, the slot stays `$` and the record is counted, so the
 * exporter can report that the file is not valid IFC2X3.
 *
 * One per export: the exporter settles the reference before the first record
 * and reads {@link unfilledWarning} after the last.
 *
 * Twin of `rust/export/src/schema_owner_history.rs`.
 */
export class OwnerHistoryFill {
  /** Records written with `$` in a mandatory OwnerHistory slot because there
   *  was no reference to write. */
  unfilled = 0;

  /** `#N` of an `IfcOwnerHistory` the export writes, as numbered in the
   *  OUTPUT, or null while it has none; set through {@link prefer}. */
  private ref: string | null = null;

  /** Switch to `ref` when there is one; otherwise keep the current reference.
   *  The merged exporter calls this per model, so a model without an owner
   *  history of its own reuses one an earlier model wrote. */
  prefer(ref: string | null): void {
    if (ref !== null) this.ref = ref;
  }

  /**
   * Fill slot 1 of an already-converted IFC2X3 line `#id=TYPE(attrs);` when
   * `TYPE` is an `IfcRoot` subtype and the slot is `$`. Every other byte of
   * the line is kept; a line that does not parse is returned unchanged.
   */
  apply(line: string, maxReferenceId?: number): string {
    const open = line.indexOf('(');
    const close = line.lastIndexOf(')');
    const eq = line.indexOf('=');
    if (eq < 0 || open <= eq || close <= open) return line;
    if (!isRooted(line.slice(eq + 1, open).trim())) return line;
    const slots = splitTopLevelStepArguments(line.slice(open + 1, close), maxReferenceId);
    if (slots === null || slots.length < 2 || withoutComments(slots[1]) !== '$') return line;
    if (this.ref === null) {
      this.unfilled++;
      return line;
    }
    slots[1] = this.ref;
    return `${line.slice(0, open + 1)}${slots.join(',')}${line.slice(close)}`;
  }

  /** The warning for {@link unfilled}, or none when every slot was filled.
   *  Same text as the Rust twin's. */
  unfilledWarnings(): string[] {
    if (this.unfilled === 0) return [];
    return [
      `${this.unfilled} record(s) keep $ in OwnerHistory, which IFC2X3 requires, because the ` +
      'export writes no IfcOwnerHistory to point them at; the file is not valid IFC2X3 (#4686).',
    ];
  }
}

/**
 * `#id` of the first owner history in `ids` (source order) that `written`
 * accepts, numbered in the output (`offset` added), or null when none is.
 * `ids` is a store's `byType.get('IFCOWNERHISTORY')`.
 */
export function firstWrittenOwnerHistoryRef(
  ids: readonly number[] | undefined,
  written: (id: number) => boolean,
  offset: number,
): string | null {
  const id = ids?.find(written);
  return id === undefined ? null : `#${id + offset}`;
}
