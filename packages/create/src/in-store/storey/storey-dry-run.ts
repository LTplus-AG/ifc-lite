/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';

const ROLLBACK = Symbol('storey dry run');

/**
 * Run `edit` in a synchronous transaction that never publishes, rethrowing
 * whatever stopped it (#8452). A prepared draft copied and compared the whole
 * session overlay for every storey plan; the ordinary transaction stages only
 * what the edit touches and discards it on the way out.
 */
export function dryRunTransaction(view: MutablePropertyView, edit: (draft: MutablePropertyView) => void): void {
  try {
    view.runAtomic((draft) => { edit(draft); throw ROLLBACK; });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}
