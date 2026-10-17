/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Attributes a schema RENAMED IN PLACE (#7739): the one allowance table that
 * lets schema conversion trim or pad a type whose name lists are not name-wise
 * prefixes of each other only because of a rename.
 *
 * `IfcStairFlight` is `[.., Tag, NumberOfRiser, ..]` in IFC2X3 and
 * `[.., Tag, NumberOfRisers, .., PredefinedType]` in IFC4: by name neither is a
 * prefix of the other, so the record kept its source arity and was written one
 * slot short (up) or long (down) for the declared target. Reading both spellings
 * as one name makes IFC2X3 a strict prefix of IFC4.
 *
 * Only renames reviewed as the same concept at the same index are listed; types
 * where a schema inserted, reordered or retyped attributes stay out, because
 * trimming or padding them would shift values into the wrong slots. Twin of
 * `rust/export/src/schema_renames.rs`; both are held to
 * `rust/export/tests/fixtures/schema_positional_renames.json`.
 */

/** Entity type -> `[older name, newer name]` pairs. */
export const POSITIONAL_RENAMES: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  IFCACTIONREQUEST: [['RequestID', 'Identification']],
  IFCCLASSIFICATIONREFERENCE: [['ItemReference', 'Identification']],
  IFCDOCUMENTREFERENCE: [['ItemReference', 'Identification']],
  IFCLIBRARYREFERENCE: [['ItemReference', 'Identification']],
  IFCPERMIT: [['PermitID', 'Identification']],
  IFCPROJECTORDER: [['ID', 'Identification']],
  IFCCOSTVALUE: [['CostType', 'Category']],
  IFCSTAIRFLIGHT: [['NumberOfRiser', 'NumberOfRisers']],
  IFCWORKPLAN: [['Identifier', 'Identification'], ['WorkControlType', 'PredefinedType']],
  IFCWORKSCHEDULE: [['Identifier', 'Identification'], ['WorkControlType', 'PredefinedType']],
  IFCPROPERTYBOUNDEDVALUE: [['Description', 'Specification']],
  IFCPROPERTYTABLEVALUE: [['Description', 'Specification']],
};

function newerName(entityType: string | undefined, name: string): string {
  const pairs = entityType === undefined ? undefined : POSITIONAL_RENAMES[entityType];
  return pairs?.find(([older]) => older === name)?.[1] ?? name;
}

/**
 * True when `shorter` is a STRICT prefix of `longer` by attribute name, with
 * the in-place renames of `entityType` read as one name: the longer form only
 * *appended* attributes to the shorter one. Both the trailing-`$` padding
 * (upgrade) and the tail trim (downgrade) are only safe then; many entities
 * insert/reorder attributes mid-list (e.g. IfcMaterialProperties, IfcApproval,
 * IfcTask), where padding or trimming would shift values into the wrong slots.
 *
 * Callers pass the shorter schema's list first, whichever direction they run in.
 * Twin of Rust `is_strict_attr_prefix`.
 */
export function isStrictAttrPrefix(
  shorter: readonly string[],
  longer: readonly string[],
  entityType?: string,
): boolean {
  if (shorter.length >= longer.length) return false;
  for (let i = 0; i < shorter.length; i++) {
    if (newerName(entityType, shorter[i]) !== newerName(entityType, longer[i])) return false;
  }
  return true;
}
