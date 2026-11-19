/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import { roomSymbolicSource } from '@/lib/collab/room-symbolic-source';

/**
 * The one "this store has no STEP records" check (#10191). The export dialog
 * names it up front and the STEP writer refuses on it.
 *
 * Tabular is the reason to look for records, not the refusal itself: a shared
 * room's store is tabular and can still carry a registered portable STEP
 * source. The question is whether a source is REGISTERED, not whether it still
 * covers the room. A room that moved past its source passes here and is
 * refused by the writer as `'roomMoved'`.
 *
 * Kept in its own file so the dialog and the command palette do not import
 * `room-step-export.ts`, which pulls `@ifc-lite/export`, `@ifc-lite/mutations`
 * and the placement-edit boot module.
 */
export function stepRecordsUnavailableReason(store: IfcDataStore): 'noRecords' | null {
  return store.sourceKind === 'tabular' && !roomSymbolicSource(store) ? 'noRecords' : null;
}
