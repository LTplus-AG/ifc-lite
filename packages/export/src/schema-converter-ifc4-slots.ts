/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { IFC4_REQUIRED_SLOTS, type Ifc4RequiredSlot } from './generated/ifc4-required-slots.js';

/** The generated rows keyed by UPPERCASE entity type, built once. */
const BY_TYPE: ReadonlyMap<string, { arity: number; slots: readonly Ifc4RequiredSlot[] }> =
  new Map(IFC4_REQUIRED_SLOTS.map(([type, arity, slots]) => [type, { arity, slots }]));

/**
 * Slots IFC4 requires a value in, on a downgrade from IFC4X3 or IFC5 to IFC4
 * (#5202).
 *
 * `schema-converter.ts` only guarded this for `toSchema === 'IFC2X3'`
 * (`Ifc2x3SlotFill`, #4714). IFC4X3 made some attributes optional that IFC4
 * declares mandatory — `IfcProjectedCRS.Name` and
 * `IfcCoordinateReferenceSystem.Name` (concretely `IfcProjectedCRS`, the
 * abstract base's only IFC4 subtype) both at position 0 — so a valid IFC4X3
 * (or IFC5) record legitimately carries `$` where the IFC4 target requires a
 * value.
 *
 * `convertStepLine` only consults this for `fromSchema` `'IFC4X3'`/`'IFC5'`.
 * IFC2X3 → IFC4 is a different, separately-audited upgrade path — IFC2X3's
 * own mandatory/optional shape was never checked against this table, and
 * `schema-converter-door-window-type.test.ts` already pins that direction
 * byte-for-byte, so applying this fill there risked silently rewriting an
 * already-correct conversion.
 *
 * Unlike {@link Ifc2x3SlotFill}, this class fills only BOOLEAN slots with
 * `.F.`. `IfcRoot.OwnerHistory` needs no reuse policy here — it is optional
 * in IFC4X3 AND in IFC4, so there is no mandatory/optional mismatch on that
 * slot to reconcile (see `schema-converter-owner-history.ts`). Every
 * enum-typed required slot is deliberately left unfilled and counted, the
 * same as any measure, label, identifier or entity reference: writing this
 * table's own invented member would be indistinguishable from the
 * enum-member-reconciliation gap #5202 also documents as UNFIXED, and filling
 * it here would hide that gap rather than close it.
 *
 * Every record this fills was ALREADY reconciled to IFC4's attribute shape by
 * `convertRecord`'s trim/pad logic — this only ever changes a `$` the source
 * genuinely wrote, never a value that was already there.
 */
export class Ifc4SlotFill {
  /** Slots written with `$` where IFC4 requires a value and the schema offers
   *  no honest default. Counted per SLOT, not per record: one record can
   *  leave several. */
  private requiredUnfilled = 0;

  /** One warning when any slot was left unfilled, in the channel the
   *  exporters already carry. */
  warnings(): string[] {
    if (this.requiredUnfilled === 0) return [];
    return [
      `${this.requiredUnfilled} slot(s) keep $ where IFC4 requires a value and the schema offers ` +
      'no default that claims nothing (measures, labels, identifiers, references, and every enum); ' +
      'the file is not valid IFC4 (#5202).',
    ];
  }

  /**
   * Write the recorded fill into every required slot of `line` that holds `$`,
   * counting the ones with no fill. The line is returned as it is when it
   * does not parse, when IFC4 declares no required slot for its type, or when
   * its ARITY is not the one IFC4 declares — the same "record was not
   * reconciled to this list, so position `i` there is not attribute `i` here"
   * guard {@link Ifc2x3SlotFill} uses.
   */
  apply(line: string): string {
    const open = line.indexOf('(');
    const close = line.lastIndexOf(')');
    const eq = line.indexOf('=');
    if (eq < 0 || open <= eq || close <= open) return line;
    const row = BY_TYPE.get(line.slice(eq + 1, open).trim().toUpperCase());
    if (row === undefined) return line;
    const values = splitTopLevelStepArguments(line.slice(open + 1, close));
    if (values === null || values.length !== row.arity) return line;
    let changed = false;
    for (const [index, , fill] of row.slots) {
      if (values[index].trim() !== '$') continue;
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
