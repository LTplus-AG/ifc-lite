/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Finish the open Polyline or Radius sequence: the one implementation behind
 * Enter and the Finish button in the Measurements list's live row (#8991),
 * which is how a touch user finishes (a finger has no Enter and no dblclick).
 *
 * The mouse double-click is the only other finish gesture and stays separate
 * on purpose: it alone may drop the trailing near-duplicate point its own
 * second click appended (`finishPolylineFromDoubleClick` in
 * selectionHandlers.ts). Enter and a button append nothing, so they must not
 * drop anything.
 */

import { useViewerStore } from './index.js';
import { MIN_RADIUS_POINTS } from '@/components/viewer/tools/measure-modes/radius';

/** The toast for a finish with too few points: shared by every finish gesture. */
export function toastTooFewPoints(kind: 'polyline' | 'radius'): void {
  const message = kind === 'polyline' ? 'Polyline needs at least 2 points' : `Radius needs at least ${MIN_RADIUS_POINTS} points`;
  void import('@/components/ui/toast').then(({ toast }) => toast.error(message));
}

/** Finish the open polyline as an open length. False when none is open. */
export function finishOpenPolyline(): boolean {
  const state = useViewerStore.getState();
  if (!state.activePolyline) return false;
  if (!state.finishPolyline(false)) toastTooFewPoints('polyline');
  return true;
}

/** Finish the open radius sequence. False when none is open. */
export function finishOpenRadius(): boolean {
  const state = useViewerStore.getState();
  if (!state.activeRadius) return false;
  if (!state.finishRadius()) toastTooFewPoints('radius');
  return true;
}

/** Finish whichever sequence is open (Enter). False when neither is. */
export function finishOpenMeasureSequence(): boolean {
  return finishOpenPolyline() || finishOpenRadius();
}
