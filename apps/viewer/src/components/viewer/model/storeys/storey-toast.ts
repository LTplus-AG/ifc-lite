/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { toast } from '@/components/ui/toast';
import { resolve } from '@/i18n/registry';

/** Toast actions fetch their implementation only when the action is clicked. */
export function loadStoreyToastAction(run: (actions: typeof import('./storey-toast-actions')) => void): void {
  void import('./storey-toast-actions').then(run).catch((error: unknown) => {
    toast.error(resolve('storeyManager.refusal.other', { reason: error instanceof Error ? error.message : String(error) }));
  });
}
