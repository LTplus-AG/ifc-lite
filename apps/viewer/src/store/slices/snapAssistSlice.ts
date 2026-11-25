/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Snap settings beside `snapEnabled` (#11504), composed into the measurement slice.
 *
 * `snapXray` is the user's X-ray-while-picking preference: models render
 * see-through and corners hidden behind other geometry can be snapped. It only
 * takes effect while a point is being picked (`isSnapPicking`); the visibility
 * channels (`ghostExceptEntities`) are never written for it, so switching it
 * off restores the previous appearance exactly. `repositionPicking` is the one
 * fact the viewport cannot read from `activeTool`: Reposition picks run in the
 * Select tool, so the picking hook reports when it is armed.
 */

export interface SnapAssistSlice {
  snapXray: boolean;
  repositionPicking: boolean;
  toggleSnapXray: () => void;
  setRepositionPicking: (picking: boolean) => void;
}

type Set = (fn: (state: SnapAssistSlice) => Partial<SnapAssistSlice>) => void;

export function createSnapAssistSlice(set: Set): SnapAssistSlice {
  return {
    snapXray: false,
    repositionPicking: false,
    toggleSnapXray: () => set((state) => ({ snapXray: !state.snapXray })),
    setRepositionPicking: (picking) => set(() => ({ repositionPicking: picking })),
  };
}
