/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { mutationPermission, type MutationDenialReason } from '@/store/mutation-permission';

/** Subscribe authoring controls to the same policy enforced at commit time (#5901). */
export function useMutationDenialReason(modelId?: string): MutationDenialReason | null {
  return useViewerStore(state => {
    const permission = mutationPermission(state, modelId);
    return permission.allowed ? null : permission.reason;
  });
}
