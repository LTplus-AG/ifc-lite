/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Snap state beside `snapEnabled` (#11517), composed into the measurement slice.
 *
 * `repositionPicking` is the one fact the viewport cannot read from
 * `activeTool`: Reposition picks run in the Select tool, so the picking hook
 * reports when it is armed and the marker overlay knows to draw.
 */

export interface SnapAssistSlice {
  repositionPicking: boolean;
  setRepositionPicking: (picking: boolean) => void;
}

type Set = (fn: (state: SnapAssistSlice) => Partial<SnapAssistSlice>) => void;

export function createSnapAssistSlice(set: Set): SnapAssistSlice {
  return {
    repositionPicking: false,
    setRepositionPicking: (picking) => set(() => ({ repositionPicking: picking })),
  };
}
