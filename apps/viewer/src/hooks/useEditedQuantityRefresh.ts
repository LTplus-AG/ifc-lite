/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useSyncExternalStore } from 'react';
import { useViewerStore } from '@/store';
import {
  isEditedQuantityRefreshEnabled,
  setEditedQuantityRefresh,
  subscribeEditedQuantityRefresh,
} from '@/lib/quantities/edited-quantity-refresh';

/**
 * Turn "Update quantities of edited elements" on or off. Every reader of a
 * view's quantities (Properties, Measure, lists) recomputes on
 * `mutationVersion`, so the change shows at once; nothing is written to the
 * overlay or its history, and a file already saved is untouched.
 */
export function applyEditedQuantityRefresh(next: boolean): void {
  if (next === isEditedQuantityRefreshEnabled()) return;
  setEditedQuantityRefresh(next);
  useViewerStore.setState((state) => ({ mutationVersion: state.mutationVersion + 1 }));
}

/** The setting and its setter, for a switch. */
export function useEditedQuantityRefresh(): readonly [boolean, (next: boolean) => void] {
  const enabled = useSyncExternalStore(subscribeEditedQuantityRefresh, isEditedQuantityRefreshEnabled, isEditedQuantityRefreshEnabled);
  return [enabled, useCallback((next: boolean) => applyEditedQuantityRefresh(next), [])] as const;
}
