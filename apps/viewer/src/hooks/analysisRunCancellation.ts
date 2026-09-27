/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';

type MutableRef<T> = { current: T };

/** Supersede an old job and stop its abortable work before another run starts. */
export function invalidateAbortableRun(
  epoch: MutableRef<number>,
  active: MutableRef<AbortController | null>,
): number {
  const next = ++epoch.current;
  active.current?.abort();
  active.current = null;
  return next;
}

export function beginAbortableRun(
  epoch: MutableRef<number>,
  active: MutableRef<AbortController | null>,
): { runEpoch: number; controller: AbortController } {
  const runEpoch = invalidateAbortableRun(epoch, active);
  const controller = new AbortController();
  active.current = controller;
  return { runEpoch, controller };
}

export function cancelClashRun(
  epoch: MutableRef<number>,
  active: MutableRef<AbortController | null>,
): void {
  invalidateAbortableRun(epoch, active);
  const state = useViewerStore.getState();
  state.setClashRunning(false);
  state.setClashProgress(null);
  state.setClashError(null);
}

export function cancelCompareRun(epoch: MutableRef<number>): void {
  epoch.current += 1;
  const state = useViewerStore.getState();
  state.setCompareRunning(false);
  state.setCompareError(null);
}
