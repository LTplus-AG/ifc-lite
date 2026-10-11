/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit-aware numeric input (IDS-045). IDS stores measures in SI; the author
 * may type "2400 mm". The number and unit are split here and sent as a
 * `range` draft's `unit`, which the `@ifc-lite/ids-authoring` reducer converts
 * to SI (one conversion table, in the package). This module only parses and
 * names the SI unit a measure data type is compared in.
 */

/** Units offered in the picker; any unit the reducer knows is accepted. */
export const UNIT_SUGGESTIONS: readonly string[] = ['mm', 'cm', 'm', 'mm2', 'm2', 'mm3', 'l', 'm3', 'kg', 't', 'kN', 'kPa', 'MPa', 'deg', 'degC', 's', 'min', 'h'];

/** SI unit each IFC measure type is compared in (the validator rescales model units to these). */
const MEASURE_SI: Readonly<Record<string, string>> = {
  IFCLENGTHMEASURE: 'm',
  IFCPOSITIVELENGTHMEASURE: 'm',
  IFCNONNEGATIVELENGTHMEASURE: 'm',
  IFCAREAMEASURE: 'm²',
  IFCVOLUMEMEASURE: 'm³',
  IFCMASSMEASURE: 'kg',
  IFCFORCEMEASURE: 'N',
  IFCPRESSUREMEASURE: 'Pa',
  IFCPLANEANGLEMEASURE: 'rad',
  IFCPOSITIVEPLANEANGLEMEASURE: 'rad',
  IFCTHERMODYNAMICTEMPERATUREMEASURE: 'K',
  IFCTIMEMEASURE: 's',
};

/** The SI unit a measure data type is compared in, or undefined for a non-measure type. */
export function siUnitOf(dataType: string | undefined): string | undefined {
  return dataType ? MEASURE_SI[dataType.toUpperCase()] : undefined;
}

const QUANTITY = /^\s*([-+]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][-+]?\d+)?)\s*([A-Za-z°µ][A-Za-z°µ²³0-9]*)\s*$/;

/**
 * Split "2400 mm" into its number and unit. A plain number, or text that is
 * not a quantity, comes back unchanged with no unit. A decimal comma is read
 * as a point ("2,4 m").
 */
export function splitQuantity(text: string): { number: string; unit?: string } {
  const match = QUANTITY.exec(text);
  if (!match) return { number: text };
  return { number: match[1].replace(',', '.'), unit: match[2] };
}
