/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What `bim.store.copyElements`, `arrayElements` and `copyToStoreys` return
 * (#9352): one ref per selected element per transform, in selection order,
 * including a door or window selected with its wall (it is copied with the
 * wall). A copy whose top could not follow its new storey says so.
 */

import type { SelectedCopy } from '@ifc-lite/create';
import type { EntityRef } from './types.js';

/** A copy left fixed at its source's height because its top could not follow its new storey. */
export interface CopyUnattachedTopNotice {
  /** The copy (the selected element's copy or one it carries). */
  readonly expressId: number;
  readonly reason: string;
}

export interface CopiedElementRef extends EntityRef {
  /** Copies of this element, or of what it carries, that keep their height and are no longer attached. Absent when none. */
  readonly unattachedTops?: readonly CopyUnattachedTopNotice[];
}

export function copiedElementRefs(modelId: string, copies: readonly SelectedCopy[]): CopiedElementRef[] {
  return copies.map(({ copyId, unattachedTops }) => unattachedTops?.length
    ? { modelId, expressId: copyId, unattachedTops: unattachedTops.map(({ copyId: expressId, reason }) => ({ expressId, reason })) }
    : { modelId, expressId: copyId });
}
