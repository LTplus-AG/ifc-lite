/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tour run state lives in its OWN zustand store, not a viewer-store slice:
 * `resetViewerState` fires inside every `loadFile` and would wipe a slice
 * exactly when a tour's "Load demo project" step runs, and keeping the
 * dependency one-directional (engine subscribes TO the viewer store) avoids
 * feedback churn. The controller (a plain module singleton) is the only
 * writer; components read via the hook.
 */

import { create } from 'zustand';
import type { TourId, TourSource, TourStatus, TourStepPhase } from './types';

export interface TourUiState {
  status: TourStatus;
  tourId: TourId | null;
  source: TourSource | null;
  stepIndex: number;
  stepPhase: TourStepPhase;
  /** Resolved anchor element for the active step (null for canvas steps). */
  targetEl: HTMLElement | null;
  /** Gate hint (emphasized Skip) after `hintAfterMs`. */
  hintVisible: boolean;
  /** The step's predicate threw - it degraded to a passive Next step. */
  gateBroken: boolean;
  /** The engine re-docked a floating / popped-out panel for this step. */
  redockedPanel: boolean;
  /** A demo-kit load is in flight (spinner on the card action). */
  demoLoading: boolean;
}

const INITIAL: TourUiState = {
  status: 'idle',
  tourId: null,
  source: null,
  stepIndex: 0,
  stepPhase: 'preparing',
  targetEl: null,
  hintVisible: false,
  gateBroken: false,
  redockedPanel: false,
  demoLoading: false,
};

export const useTourStore = create<TourUiState>()(() => ({ ...INITIAL }));

export function patchTourState(patch: Partial<TourUiState>): void {
  useTourStore.setState(patch);
}

export function resetTourState(): void {
  useTourStore.setState({ ...INITIAL });
}
