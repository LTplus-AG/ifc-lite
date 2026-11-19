/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { guardAnalysisRun, type AnalysisRunGuard } from './analysisRunGuard';

type MutableRef<T> = { current: T };

export interface ClashRunSession {
  controller: AbortController;
  cancel: () => void;
  /** Ends the run when a teardown changes the model session it read (A2):
   *  `clearClash` only resets the flags, so without it the engine kept its
   *  unaborted signal and its progress kept landing under `clashRunning: false`. */
  guard: AnalysisRunGuard;
}

// The run authority survives panel closure; it is released only by native
// completion or supersession. A tray row captures this exact session.
let clashSession: ClashRunSession | null = null;
export const activeClashRunSession = (): ClashRunSession | null => clashSession;

function endClashSession(controller: AbortController | null): void {
  if (!clashSession || clashSession.controller !== controller) return;
  clashSession.guard.dispose();
  clashSession = null;
}

export function releaseAbortableRun(controller: AbortController, active: MutableRef<AbortController | null>): void {
  if (active.current === controller) active.current = null;
  endClashSession(controller);
}

/** Supersede an old job and stop its abortable work before another run starts. */
export function invalidateAbortableRun(
  epoch: MutableRef<number>,
  active: MutableRef<AbortController | null>,
): number {
  const next = ++epoch.current;
  const previous = active.current;
  previous?.abort();
  endClashSession(previous);
  active.current = null;
  return next;
}

/** Supersede the previous job and own a fresh abortable one: every later
 *  invalidation of `epoch` aborts it, so the engine stops, not only its writes. */
export function startAbortableRun(
  epoch: MutableRef<number>,
  active: MutableRef<AbortController | null>,
): { runEpoch: number; controller: AbortController } {
  const runEpoch = invalidateAbortableRun(epoch, active);
  const controller = new AbortController();
  active.current = controller;
  return { runEpoch, controller };
}

export function beginAbortableRun(
  epoch: MutableRef<number>,
  active: MutableRef<AbortController | null>,
): { runEpoch: number; controller: AbortController; guard: AnalysisRunGuard } {
  // One native clash result slot: a newer caller supersedes its previous owner.
  clashSession?.cancel();
  const { runEpoch, controller } = startAbortableRun(epoch, active);
  const cancel = (): void => {
    if (clashSession !== session || active.current !== controller || epoch.current !== runEpoch) return;
    cancelClashRun(epoch, active);
  };
  // Armed before the gather: a reset during the paint-frame wait is seen
  // through the run generation; the caller `track`s what it then gathered.
  const session: ClashRunSession = { controller, cancel, guard: guardAnalysisRun(useViewerStore, cancel) };
  clashSession = session;
  return { runEpoch, controller, guard: session.guard };
}

/** Explicit workspace Clear cancels whichever hook owns the current run. */
export function clearClashRun(epoch: MutableRef<number>, active: MutableRef<AbortController | null>): void {
  clashSession?.cancel();
  invalidateAbortableRun(epoch, active);
}

export function cancelClashRun(
  epoch: MutableRef<number>,
  active: MutableRef<AbortController | null>,
): void {
  // A passive/older mounted hook must not clear the current owner's UI.
  if (clashSession && clashSession.controller !== active.current) return;
  invalidateAbortableRun(epoch, active);
  const state = useViewerStore.getState();
  state.setClashRunning(false);
  state.setClashProgress(null);
  state.setClashError(null);
}

export function cancelCompareRun(epoch: MutableRef<number>, active: MutableRef<AbortController | null>): void {
  invalidateAbortableRun(epoch, active);
  const state = useViewerStore.getState();
  state.setCompareRunning(false);
  state.setCompareError(null);
}
