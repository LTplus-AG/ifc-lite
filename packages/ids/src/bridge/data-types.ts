/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Map the parser's `PropertyValueType` enum (or string-tagged variant)
 * to the IDS-side `IFC*` data-type token consumers compare against.
 * IDS expects names like `IFCLABEL` / `IFCREAL` / `IFCBOOLEAN`; the
 * parser surfaces shape-only enum values plus the underlying IFC
 * measure name on the property record.
 */
export function idsDataTypeForProperty(type: number | string | undefined): string {
  if (typeof type === 'string') {
    if (type.startsWith('IFC') || type.startsWith('Ifc')) return type.toUpperCase();
    return 'IFCLABEL';
  }
  // PropertyValueType enum from @ifc-lite/data:
  //   0 String, 1 Real, 2 Integer, 3 Boolean, 4 Logical,
  //   5 Label, 6 Identifier, 7 Text, 8 Enum, 9 Reference, 10 List.
  switch (type) {
    case 0: return 'IFCLABEL';
    case 1: return 'IFCREAL';
    case 2: return 'IFCINTEGER';
    case 3: return 'IFCBOOLEAN';
    case 4: return 'IFCLOGICAL';
    case 5: return 'IFCLABEL';
    case 6: return 'IFCIDENTIFIER';
    case 7: return 'IFCTEXT';
    case 8: return 'IFCLABEL';
    case 9: return 'IFCIDENTIFIER';
    case 10: return 'IFCLABEL';
    default: return 'IFCLABEL';
  }
}

/** QuantityType enum → IDS measure name. */
export function idsDataTypeForQuantity(type: number): string {
  switch (type) {
    case 0: return 'IFCLENGTHMEASURE';
    case 1: return 'IFCAREAMEASURE';
    case 2: return 'IFCVOLUMEMEASURE';
    case 3: return 'IFCCOUNTMEASURE';
    case 4: return 'IFCMASSMEASURE';
    case 5: return 'IFCTIMEMEASURE';
    default: return 'IFCLABEL';
  }
}
