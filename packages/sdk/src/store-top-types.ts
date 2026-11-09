/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TopConstraint } from '@ifc-lite/create';

/**
 * What a new wall's, column's, beam's, member's or curtain wall's top is
 * attached to (#9296). `auto` (the default) is the Model workspace's "To
 * storey above": an element whose top lands on the storey above its own is
 * attached to it relatively, so it follows later level edits, inserted
 * storeys and copies to other storeys; any other is fixed-height. Pass
 * `{ kind: 'fixed' }` to draw it fixed even when it reaches the storey above.
 */
export interface TopConstraintParams {
  TopConstraint?: TopConstraint | 'auto';
}
