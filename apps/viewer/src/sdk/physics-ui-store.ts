/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tiny dedicated store for physics-result UI state.
 *
 * Lives next to the viewer-side physics-adapter rather than in the main
 * viewer store because (a) the data only matters while the panel is open,
 * (b) it doesn't need cross-slice glue, and (c) it lets us delete this
 * cleanly when the panel grows into a richer analysis tool.
 */

import { create } from 'zustand';
import type { EntityRef, PhysicsSimulationResult } from '@ifc-lite/sdk';

export interface PhysicsResultUiState {
  result: PhysicsSimulationResult | null;
  /** Entity that was removed to produce the result, if any. */
  removed: { ref: EntityRef; name: string; ifcType: string } | null;
  set: (
    result: PhysicsSimulationResult,
    removed: { ref: EntityRef; name: string; ifcType: string } | null,
  ) => void;
  clear: () => void;
}

export const usePhysicsResultStore = create<PhysicsResultUiState>((set) => ({
  result: null,
  removed: null,
  set: (result, removed) => set({ result, removed }),
  clear: () => set({ result: null, removed: null }),
}));
