/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { withoutComments } from './step-comment-skip.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { OwnerHistoryFill } from './schema-converter-owner-history.js';
import { IFC2X3_REQUIRED_SLOTS, type Ifc2x3RequiredSlot } from './generated/ifc2x3-required-slots.js';

/** Re-exported so an exporter has ONE door to the IFC2X3 slot fills: which
 *  owner history to {@link Ifc2x3SlotFill.prefer} is part of the same job. */
export { firstWrittenOwnerHistoryRef } from './schema-converter-owner-history.js';

/** The generated rows keyed by UPPERCASE entity type, built once. */
const BY_TYPE: ReadonlyMap<string, { arity: number; slots: readonly Ifc2x3RequiredSlot[] }> =
  new Map(IFC2X3_REQUIRED_SLOTS.map(([type, arity, slots]) => [type, { arity, slots }]));

/**
 * Slots IFC2X3 requires a value in, on a downgrade to IFC2X3 (#4714).
 *
 * IFC4 made attributes optional that IFC2X3 declares mandatory, so a valid
 * IFC4 record legitimately carries `$` where the IFC2X3 target requires a
 * value. Two policies settle those slots, and this is the one object an
 * exporter threads through {@link convertStepLine} to apply both:
 *
 * - `IfcRoot.OwnerHistory` is REUSED from an `IfcOwnerHistory` the export
 *   already writes ({@link OwnerHistoryFill}, #4686). Nothing is invented,
 *   because an owner history asserts who made the model, with which
 *   application, when.
 * - Every other required slot is read from the generated
 *   `IFC2X3_REQUIRED_SLOTS` table. An enum with a `NOTDEFINED` member takes
 *   `.NOTDEFINED.` and a BOOLEAN takes `.F.`, the values that claim nothing. A
 *   measure, label, identifier or entity reference has no such value, so the
 *   slot keeps `$` and is COUNTED: the caller learns the file is not valid
 *   IFC2X3 rather than receiving a fabricated dimension.
 *
 * One per export: the exporter settles the owner history before the first
 * record and reads {@link warnings} after the last.
 *
 * Twin of `rust/export/src/schema_ifc2x3_slots.rs`.
 */
export class Ifc2x3SlotFill {
  private readonly ownerHistory = new OwnerHistoryFill();

  /** Slots other than `OwnerHistory` written with `$` where IFC2X3 requires a
   *  value and the schema offers no honest default. Counted per SLOT, not per
   *  record: one record can leave several. */
  private requiredUnfilled = 0;

  /** Switch to `ref` when there is one; otherwise keep the current reference.
   *  The merged exporter calls this per model, so a model without an owner
   *  history of its own reuses one an earlier model wrote. */
  prefer(ref: string | null): void {
    this.ownerHistory.prefer(ref);
  }

  /** Apply both fills to an already-converted IFC2X3 line `#id=TYPE(attrs);`. */
  apply(line: string, maxReferenceId?: number): string {
    return this.fillRequired(this.ownerHistory.apply(line, maxReferenceId), maxReferenceId);
  }

  /** One warning per non-zero counter, in the channel the exporters already
   *  carry. Same texts as the Rust twin's. */
  warnings(): string[] {
    const out = this.ownerHistory.unfilledWarnings();
    if (this.requiredUnfilled > 0) {
      out.push(
        `${this.requiredUnfilled} slot(s) keep $ where IFC2X3 requires a value and the schema ` +
        'offers no default that claims nothing (measures, labels, references, and enums with no ' +
        'NOTDEFINED member); the file is not valid IFC2X3 (#4714).',
      );
    }
    return out;
  }

  /**
   * Write the recorded fill into every required slot of `line` that holds `$`,
   * counting the ones with no fill. The line is returned as it is when it does
   * not parse (the converter already passed it through for the same reason),
   * when IFC2X3 declares no required slot for its type, or when its ARITY is
   * not the one IFC2X3 declares.
   *
   * That last guard is what keeps a fill from landing on the wrong attribute.
   * The table's indexes are positions in the IFC2X3 attribute list; a record
   * carrying a different number of slots was not reconciled to that list (the
   * downgrade only trims and pads the types whose attribute-name lists are
   * prefix-related), so position `i` there need not be attribute `i` here.
   * Such a record is left alone AND not counted: nothing about its required
   * slots was established.
   */
  private fillRequired(line: string, maxReferenceId?: number): string {
    const open = line.indexOf('(');
    const close = line.lastIndexOf(')');
    const eq = line.indexOf('=');
    if (eq < 0 || open <= eq || close <= open) return line;
    const row = BY_TYPE.get(line.slice(eq + 1, open).trim().toUpperCase());
    if (row === undefined) return line;
    const values = splitTopLevelStepArguments(line.slice(open + 1, close), maxReferenceId);
    if (values === null || values.length !== row.arity) return line;
    let changed = false;
    for (const [index, , fill] of row.slots) {
      if (withoutComments(values[index]) !== '$') continue;
      if (fill === null) {
        this.requiredUnfilled++;
        continue;
      }
      values[index] = fill;
      changed = true;
    }
    return changed ? `${line.slice(0, open + 1)}${values.join(',')}${line.slice(close)}` : line;
  }
}
