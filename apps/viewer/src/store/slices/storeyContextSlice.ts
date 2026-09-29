/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's storey context (charter #6232, decision D9): what 3D
 * does with the storeys above the one being drawn on. Upper floors and the
 * roof otherwise hide the work area and the selection.
 *
 *   - `hide`  (default): everything above the active storey is hidden.
 *   - `ghost`          : it renders translucent.
 *   - `all`            : nothing changes.
 *
 * Only the user's choice lives here, remembered for the browser session. The
 * ids it applies to are DERIVED (`lib/visibility/storey-context.ts`) from the
 * session storey and folded into the renderer's hidden / ghost input, never
 * written into the shared visibility channels, so leaving the workspace puts
 * back exactly the view the user had.
 */

import type { StateCreator } from 'zustand';

export type StoreyContextMode = 'hide' | 'ghost' | 'all';

export const STOREY_CONTEXT_MODES: readonly StoreyContextMode[] = ['hide', 'ghost', 'all'];

const STORAGE_KEY = 'ifc-lite:model-workspace:storey-context';

export interface StoreyContextSlice {
  storeyContextMode: StoreyContextMode;
  setStoreyContextMode: (mode: StoreyContextMode) => void;
}

function loadStoreyContextMode(): StoreyContextMode {
  try {
    const stored = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    return STOREY_CONTEXT_MODES.find((mode) => mode === stored) ?? 'hide';
  } catch (err) {
    console.warn('[modeling] Could not read the storey context choice:', err);
    return 'hide';
  }
}

function persistStoreyContextMode(mode: StoreyContextMode): void {
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, mode);
  } catch (err) {
    console.warn('[modeling] Could not save the storey context choice:', err);
  }
}

export const createStoreyContextSlice: StateCreator<StoreyContextSlice, [], [], StoreyContextSlice> = (set) => ({
  storeyContextMode: loadStoreyContextMode(),
  setStoreyContextMode: (storeyContextMode) => {
    persistStoreyContextMode(storeyContextMode);
    set({ storeyContextMode });
  },
});
