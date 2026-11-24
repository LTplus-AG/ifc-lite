/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #11326: a type-wide drop (a type IFC4 deleted, or a type whose attribute list shrinks) is
 * decided per TYPE, but only a slot the record populated loses anything. `()` and `''` are
 * values; `$`, `*` and an empty slot are not (twin of Rust `values_without_a_name`).
 */

import { holdsValue } from './step-comment-skip.js';

/** The slot reader the loss report already holds (`SourceRecords`). */
interface SlotReader {
  slots(id: number): readonly string[] | undefined;
}

/**
 * Whether `attribute` of record `id` is unset in the source, so dropping it loses nothing.
 * `sourceAttributes` is the source schema's attribute-name table entry for the record's type.
 * An unreadable record or an attribute the table does not name is NOT unset: it stays reported.
 */
export function isUnsetSourceAttribute(
  records: SlotReader | undefined,
  sourceAttributes: readonly string[] | undefined,
  id: number,
  attribute: string,
): boolean {
  const slot = sourceAttributes?.indexOf(attribute) ?? -1;
  const value = slot >= 0 ? records?.slots(id)?.[slot] : undefined;
  return value !== undefined && !holdsValue(value);
}
