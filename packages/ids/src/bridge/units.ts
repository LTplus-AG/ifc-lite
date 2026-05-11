/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per IDS spec, IDS literal values for IFC measure types are always in
 * base SI units. The IFC store keeps the raw author value, so when the
 * project's length unit is `MILLI`, a stored `1000` length means
 * `1.0 metre` and the IDS check `1` should match. This helper applies
 * the project's `lengthUnitScale` to numeric values for length
 * measures.
 *
 * Properties without a declared dataType (notably `IfcPropertyTableValue`,
 * where columns mix labels and measures) get a conservative double-up:
 * every numeric candidate is surfaced both raw and scaled, so an IDS
 * check using either unit space matches.
 */
export function applyUnitConversion(
  rawValue: string | number | boolean | null,
  rawValues: string[] | undefined,
  dataType: string | undefined,
  scale: number | undefined
): { value: string | number | boolean | null; values: string[] | undefined } {
  if (!scale || scale === 1) {
    return { value: rawValue, values: rawValues };
  }
  const upper = dataType ? dataType.toUpperCase() : '';
  const isLength =
    upper === 'IFCLENGTHMEASURE' || upper === 'IFCPOSITIVELENGTHMEASURE';
  const isUntypedTable =
    !dataType && Array.isArray(rawValues) && rawValues.length > 0;
  if (!isLength && !isUntypedTable) {
    return { value: rawValue, values: rawValues };
  }

  const convertNum = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n * scale : null;
  };

  if (isLength) {
    const converted = (() => {
      const c = convertNum(rawValue);
      return c == null ? rawValue : c;
    })();
    const values = Array.isArray(rawValues)
      ? rawValues.map((v) => {
          const c = convertNum(v);
          return c == null ? String(v) : String(c);
        })
      : rawValues;
    return { value: converted, values };
  }

  // Untyped table — keep raw values and append scaled copies for every
  // numeric candidate so either unit space matches.
  const expanded: string[] = [];
  for (const v of rawValues!) {
    expanded.push(String(v));
    const c = convertNum(v);
    if (c != null && String(c) !== String(v)) expanded.push(String(c));
  }
  return { value: rawValue, values: expanded };
}
