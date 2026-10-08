/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Walk-mode status, shared between the controller that owns it
 * (`walkController.ts`) and the HUD readout (`WalkIndicator.tsx`). A module
 * store like `flySpeedStore`: it changes with the walker, and nothing else
 * reads it.
 */

export interface WalkStatus {
  active: boolean;
  /** Collision and gravity on; off is the float-through mode. */
  physics: boolean;
  crouching: boolean;
}

let state: WalkStatus = { active: false, physics: true, crouching: false };
const listeners = new Set<() => void>();

export const walkStatusStore = {
  get: (): WalkStatus => state,
  set(patch: Partial<WalkStatus>): void {
    const next = { ...state, ...patch };
    if (next.active === state.active && next.physics === state.physics && next.crouching === state.crouching) return;
    state = next;
    listeners.forEach((l) => l());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
