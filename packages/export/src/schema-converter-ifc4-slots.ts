/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { IFC4_REQUIRED_SLOTS, IFC4X3_REQUIRED_SLOTS, type Ifc4RequiredSlot, type Ifc4RequiredSlotRow } from './generated/ifc4-required-slots.js';

/** A target whose required slots are counted. */
export type RequiredSlotTarget = 'IFC4' | 'IFC4X3';

const byType = (rows: readonly Ifc4RequiredSlotRow[]): ReadonlyMap<string, { arity: number; slots: readonly Ifc4RequiredSlot[] }> =>
  new Map(rows.map(([type, arity, slots]) => [type, { arity, slots }]));
/** The generated rows keyed by UPPERCASE entity type, built once per target. */
const BY_TARGET: Record<RequiredSlotTarget, ReturnType<typeof byType>> = { IFC4: byType(IFC4_REQUIRED_SLOTS), IFC4X3: byType(IFC4X3_REQUIRED_SLOTS) };

/** `$`, possibly wrapped in whitespace and STEP block comments. */
const NULL_TOKEN = /^(?:\s|\/\*[\s\S]*?\*\/)*\$(?:\s|\/\*[\s\S]*?\*\/)*$/;

/**
 * Counts slots IFC4 requires a value in that a downgrade from IFC4X3 or IFC5
 * leaves `$` (#5202).
 *
 * `schema-converter.ts` only guarded cardinality for `toSchema === 'IFC2X3'`
 * (`Ifc2x3SlotFill`, #4714). IFC4X3 made some attributes optional that IFC4
 * declares mandatory, e.g. `IfcProjectedCRS.Name` at position 0, so a valid
 * IFC4X3 (or IFC5) record legitimately carries `$` where IFC4 requires a value.
 *
 * Unlike {@link Ifc2x3SlotFill} this never writes a value. None of these
 * slots has an honest default: the only candidates were BOOLEANs, and every
 * BOOLEAN slot IFC4 requires is required in IFC4X3 too (`SameSense`,
 * `Orientation`, …), where `.F.` would flip geometry rather than claim
 * nothing. Enums stay unfilled because enum reconciliation is a separate
 * problem (#5202 finding 1). The count surfaces as one warning, so the caller
 * learns the file is not valid IFC4 instead of receiving an invented value.
 *
 * `convertStepLine` consults this for `fromSchema` `'IFC4X3'`/`'IFC5'`, and for
 * the IFC2X3 → IFC4 records a structural rewrite or an attribute map wrote
 * (`upgradeCountsIfc4Slots`, #10763). The rest of IFC2X3 → IFC4 is a separately
 * audited upgrade path, pinned byte-for-byte by `schema-converter-door-window-type.test.ts`.
 * An IFC2X3 → IFC4X3 upgrade counts the records an attribute map or the typed-property
 * pass wrote against IFC4X3's own required slots (#11135), so a slot IFC4X3 made optional
 * is not counted.
 */
export class Ifc4SlotCheck {
  /** Required slots left `$`, per target. Counted per SLOT: one record can leave several. */
  private readonly requiredUnfilled = new Map<RequiredSlotTarget, number>();

  /** One warning per target with a slot left `$`, in the exporters' warning channel. */
  warnings(): string[] {
    return [...this.requiredUnfilled].map(([target, count]) =>
      `${count} slot(s) keep $ where ${target} requires a value and the source offers none ` +
      '(the converter does not invent measures, labels, identifiers, references, flags or enums); ' +
      `the file is not valid ${target} (${target === 'IFC4' ? '#5202' : '#11135'}).`);
  }

  /**
   * Count every required slot of an already-converted `line` that holds `$`,
   * and return the line unchanged. A line that does not parse, whose type IFC4
   * gives no required slot, or whose ARITY is not IFC4's is not counted: its
   * position `i` need not be attribute `i` (the same guard
   * {@link Ifc2x3SlotFill} uses).
   */
  apply(line: string, target: RequiredSlotTarget = 'IFC4'): string {
    const open = line.indexOf('(');
    const close = line.lastIndexOf(')');
    const eq = line.indexOf('=');
    if (eq < 0 || open <= eq || close <= open) return line;
    const row = BY_TARGET[target].get(line.slice(eq + 1, open).trim().toUpperCase());
    if (row === undefined) return line;
    const values = splitTopLevelStepArguments(line.slice(open + 1, close));
    if (values === null || values.length !== row.arity) return line;
    const unfilled = row.slots.filter(([index]) => NULL_TOKEN.test(values[index])).length;
    if (unfilled) this.requiredUnfilled.set(target, (this.requiredUnfilled.get(target) ?? 0) + unfilled);
    return line;
  }
}
