/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sorted-string-list projections for {@link DataFingerprintInput} fields that
 * are, at the wire level, all the same shape: a bag of resolved NAMES (never
 * entity references — an express id is reassigned on every save), where order
 * is not content, duplicates are, and a blank/whitespace-only name says
 * nothing.
 *
 * Split out of `fingerprint.ts` so a second field of this shape (materials,
 * then classifications) does not have to grow that module's budget — the
 * hashing/sorting logic is shared, only the field's own name and its adapter
 * wiring differ.
 */
import type { DataFingerprintInput } from './fingerprint.js';

/**
 * Locale-independent string ordering: compare UTF-16 code units, never
 * `localeCompare` — a private copy of `fingerprint.ts`'s own comparator (see
 * that module for the full locale-drift argument). Kept local rather than
 * imported so this module has no runtime dependency back on `fingerprint.ts`,
 * which only imports *from* here — a value-level import back would make the
 * two modules a cycle.
 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sorted, blank-filtered projection of a resolved-name list: sorted by code
 * unit (never `localeCompare` — see {@link compareCodeUnits}), duplicates
 * kept. Absent and `[]` project identically, which is the documented contract
 * of every field this backs.
 */
function sortedStringList(values: string[] | undefined): string[] {
  return (values ?? [])
    .filter((name) => typeof name === 'string' && name.trim().length > 0)
    .sort(compareCodeUnits);
}

/**
 * Canonical projection of {@link DataFingerprintInput.materials}. See that
 * field's doc for why names (not references), why sorted, and why duplicates
 * survive.
 */
export function sortedMaterials(input: DataFingerprintInput): string[] {
  return sortedStringList(input.materials);
}

/**
 * Canonical projection of {@link DataFingerprintInput.classifications}. Same
 * shape and the same reasoning as {@link sortedMaterials}: an
 * `IfcClassificationReference` carries no cross-file identity of its own
 * (re-exported like any other `IfcRoot`-free resource), so the adapter
 * resolves it to a NAME before it ever reaches here.
 */
export function sortedClassifications(input: DataFingerprintInput): string[] {
  return sortedStringList(input.classifications);
}
