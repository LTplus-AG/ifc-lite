/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Same-named attributes IFC4 RETYPED IN PLACE between a STEP enumeration and
 * a string (#10778). An upgraded IFC2X3 `IFCMONETARYUNIT(.EUR.)` put an enum
 * into IFC4's `IfcLabel` slot, and a downgraded `IFCMONETARYUNIT('EUR')` a
 * string into IFC2X3's enum slot. An upgrade writes the member as a label; a
 * downgrade writes a label that names a member as that member and anything
 * else as `$` (the IFC2X3 slot fill then reports the required slot).
 *
 * Twin of Rust `schema_retyped.rs`; both are held to
 * `rust/export/tests/fixtures/schema_retyped_slots.json`.
 */

import type { IfcSchemaVersion } from './schema-converter.js';
import { frameArgs, stepRecordFrame } from './step-record-frame.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';

/** IFC2X3 `IfcCurrencyEnum`. */
const CURRENCY: readonly string[] = [
  'AED', 'AES', 'ATS', 'AUD', 'BBD', 'BEG', 'BGL', 'BHD', 'BMD', 'BND', 'BRL', 'BSD',
  'BWP', 'BZD', 'CAD', 'CBD', 'CHF', 'CLP', 'CNY', 'CYS', 'CZK', 'DDP', 'DEM', 'DKK',
  'EGL', 'EST', 'EUR', 'FAK', 'FIM', 'FJD', 'FKP', 'FRF', 'GBP', 'GIP', 'GMD', 'GRX',
  'HKD', 'HUF', 'ICK', 'IDR', 'ILS', 'INR', 'IRP', 'ITL', 'JMD', 'JOD', 'JPY', 'KES',
  'KRW', 'KWD', 'KYD', 'LKR', 'LUF', 'MTL', 'MUR', 'MXN', 'MYR', 'NLG', 'NZD', 'OMR',
  'PGK', 'PHP', 'PKR', 'PLN', 'PTN', 'QAR', 'RUR', 'SAR', 'SCR', 'SEK', 'SGD', 'SKP',
  'THB', 'TRL', 'TTD', 'TWD', 'USD', 'VEB', 'VND', 'XEU', 'ZAR', 'ZWD', 'NOK',
];

/** One retyped slot: `[type, index, IFC2X3 enumeration members]`. */
export const RETYPED_SLOTS: readonly (readonly [string, number, readonly string[]])[] = [['IFCMONETARYUNIT', 0, CURRENCY]];

/** `line`, already converted from `fromSchema` to `toSchema`, with every
 *  retyped slot in the target's type. `null` passes through. */
export function retypeInPlace(line: string | null, fromSchema: IfcSchemaVersion, toSchema: IfcSchemaVersion): string | null {
  const ifc4Like = (s: IfcSchemaVersion) => s === 'IFC4' || s === 'IFC4X3';
  const up = fromSchema === 'IFC2X3' && ifc4Like(toSchema);
  if (line === null || (!up && !(toSchema === 'IFC2X3' && ifc4Like(fromSchema)))) return line;
  const frame = stepRecordFrame(line, { allowMissingSemicolon: true });
  if (frame === null) return line;
  const type = line.slice(frame.head.typeStart, frame.head.typeEnd).toUpperCase();
  const slot = RETYPED_SLOTS.find(([t]) => t === type);
  const args = slot ? splitTopLevelStepArguments(frameArgs(line, frame)) : null;
  if (!slot || !args || slot[1] >= args.length) return line;
  const value = args[slot[1]].trim();
  const inner = value.slice(1, -1);
  if (value.length < 2) return line;
  if (up) {
    if (!value.startsWith('.') || !value.endsWith('.')) return line;
    args[slot[1]] = `'${inner}'`;
  } else {
    if (!value.startsWith("'") || !value.endsWith("'")) return line;
    const member = slot[2].find((m) => m.toUpperCase() === inner.toUpperCase());
    args[slot[1]] = member ? `.${member}.` : '$';
  }
  return `${line.slice(0, frame.head.open + 1)}${args.join(',')}${line.slice(frame.close)}`;
}
