/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';

type MutableRef<T> = { current: T };

export interface ClashRunSession {
  controller: AbortController;
  cancel: () => void;
}

// The run authority survives panel closure; it is released only by native
// completion or supersession. A tray row captures this exact session.
let clashSession: ClashRunSession | null = null;
export const activeClashRunSession = (): ClashRunSession | null => clashSession;

export function releaseAbortableRun(controller: AbortController, active: MutableRef<AbortController | null>): void {
  if (active.current === controller) active.current = null;
  if (clashSession?.controller === controller) clashSession = null;
}

/** Supersede an old job and stop its abortable work before another run starts. */
export function invalidateAbortableRun(
  epoch: MutableRef<number>,
  active: MutableRef<AbortController | null>,
): number {
  const next = ++epoch.current;
  const previous = active.current;
  previous?.abort();
  if (clashSession?.controller === previous) clashSession = null;
  active.current = null;
  return next;
}

export function beginAbortableRun(
  epoch: MutableRef<number>,
  active: MutableRef<AbortController | null>,
): { runEpoch: number; controller: AbortController } {
  // One native clash result slot: a newer caller supersedes its previous owner.
  clashSession?.cancel();
  const runEpoch = invalidateAbortableRun(epoch, active);
  const controller = new AbortController();
  active.current = controller;
  const session: ClashRunSession = { controller, cancel: () => {
    if (clashSession !== session || active.current !== controller || epoch.current !== runEpoch) return;
    cancelClashRun(epoch, active);
  } };
  clashSession = session;
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
