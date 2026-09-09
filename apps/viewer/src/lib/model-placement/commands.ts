/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';

export function openRepositionModels(ids?: readonly string[]): void {
  try { useViewerStore.getState().openReposition(ids); }
  catch (error) {
    console.warn('[Reposition] Cannot start model move:', error);
    toast.error(error instanceof Error ? error.message : 'Could not start repositioning.');
  }
}
