/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The label of a `.USERDEFINED.` type across IFC2X3 and IFC4 (#10824).
 * IFC2X3 kept it in a type-specific attribute (`UserDefinedControlType`,
 * `UserDefinedProcedureType`, `UserDefinedFunction`); IFC4 keeps it in
 * `ObjectType`. An upgrade writes the IFC2X3 label into an unset `ObjectType`;
 * a downgrade writes `ObjectType` into the unset IFC2X3 label. A set
 * `ObjectType` is kept. Twin of Rust `schema_userdefined_label.rs`.
 */

import { attrNameTable, type IfcSchemaVersion } from './schema-converter.js';
import { readStepSlots } from './step-argument-parser.js';
import { skipStepTrivia } from './step-slot-grammar.js';
import { stepRecordHead } from './step-record-frame.js';

/** `[IFC2X3 type, IFC4 type, IFC2X3 enum, IFC2X3 label]`; the IFC4 label is ObjectType. */
const LABEL_CARRIES: readonly (readonly [string, string, string, string])[] = [
  ['IFCPROCEDURE', 'IFCPROCEDURE', 'ProcedureType', 'UserDefinedProcedureType'],
  ['IFCWORKPLAN', 'IFCWORKPLAN', 'WorkControlType', 'UserDefinedControlType'],
  ['IFCWORKSCHEDULE', 'IFCWORKSCHEDULE', 'WorkControlType', 'UserDefinedControlType'],
  ['IFCELECTRICDISTRIBUTIONPOINT', 'IFCELECTRICDISTRIBUTIONBOARD', 'DistributionPointFunction', 'UserDefinedFunction'],
];

const ifc4Like = (s: IfcSchemaVersion) => s === 'IFC4' || s === 'IFC4X3';

/** True when `slot` is `token` (any case) with only whitespace and comments around it. */
function isToken(slot: string | undefined, token: string): boolean {
  const start = slot === undefined ? -1 : skipStepTrivia(slot, 0);
  return start !== -1 && slot!.slice(start, start + token.length).toUpperCase() === token
    && skipStepTrivia(slot!, start + token.length) === slot!.length;
}

/** No value: `$`, `*` or nothing, comments aside. A missing slot is not unset. */
const isUnset = (slot: string | undefined) => slot !== undefined
  && (isToken(slot, '$') || isToken(slot, '*') || skipStepTrivia(slot, 0) === slot.length);

/** `converted`, written from `source` between the schemas, with the label carried. */
export function carryUserDefinedLabel(source: string, converted: string, fromSchema: IfcSchemaVersion, toSchema: IfcSchemaVersion): string {
  const up = fromSchema === 'IFC2X3' && ifc4Like(toSchema);
  if (!up && !(toSchema === 'IFC2X3' && ifc4Like(fromSchema))) return converted;
  // The head names the type; most records stop here.
  const head = stepRecordHead(converted);
  const type = head ? converted.slice(head.typeStart, head.typeEnd).toUpperCase() : '';
  const carry = LABEL_CARRIES.find((c) => type === (up ? c[1] : c[0]));
  const record = carry ? readStepSlots(converted) : null;
  if (!carry || !record) return converted;
  const [ifc2x3, ifc4, kind, label] = carry;
  const at = (schema: IfcSchemaVersion, t: string, name: string) => attrNameTable(schema)?.get(t)?.indexOf(name) ?? -1;
  const out = [...record.slots];
  if (up) {
    const ot = at(toSchema, ifc4, 'ObjectType');
    // `convertRecord` also accepts a record without its ';'.
    const src = (readStepSlots(source) ?? readStepSlots(`${source};`))?.slots;
    const value = src?.[at(fromSchema, ifc2x3, label)];
    if (!src || !isToken(src[at(fromSchema, ifc2x3, kind)], '.USERDEFINED.') || value === undefined || isUnset(value) || !isUnset(out[ot])) return converted;
    out[ot] = value;
  } else {
    const ot = at(toSchema, ifc2x3, 'ObjectType');
    const l = at(toSchema, ifc2x3, label);
    if (!isToken(out[at(toSchema, ifc2x3, kind)], '.USERDEFINED.') || !isUnset(out[l]) || out[ot] === undefined || isUnset(out[ot])) return converted;
    out[l] = out[ot];
  }
  return `${record.prefix}${out.join(',')}${record.suffix}`;
}
