/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcDataStore } from '@ifc-lite/parser';

/** #7541: known scanner omissions cannot be republished as complete STEP.
 * Missing provenance remains unobserved; zero is not a full syntax verdict. */
export function assertStepSourceCompleteness(store: IfcDataStore): void {
  if ((store.malformedRecordCount ?? 0) > 0) {
    throw new Error('STEP export refused: malformed records make the source index incomplete');
  }
}
