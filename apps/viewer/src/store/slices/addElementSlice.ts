/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Add-element tool state — drives the right-side AddElementPanel and the
 * viewport's click-to-place handler.
 *
 * The actual STEP work runs through `mutationSlice` actions
 * (`addWall` / `addSlab` / `addBeam` / `addColumn`); this slice only
 * holds the panel form state (selected type, per-type dimensions,
 * target storey).
 *
 * Defaults match the IfcCreator builders' construction-standard
 * conventions (wall thickness 0.2m, floor height 3m, slab 5×5×0.3m,
 * column 0.4×0.4×3m, beam 0.3×0.5×3m).
 */

import { type StateCreator } from 'zustand';

export type AddElementType = 'wall' | 'slab' | 'beam' | 'column';

export interface AddElementWallParams {
  Thickness: number;
  Height: number;
  /** Wall length emitted along storey-local +X from the click point. */
  Length: number;
}

export interface AddElementSlabParams {
  Width: number;
  Depth: number;
  Thickness: number;
}

export interface AddElementBeamParams {
  Width: number;
  Height: number;
  /** Beam length emitted along storey-local +X from the click point. */
  Length: number;
}

export interface AddElementColumnParams {
  Width: number;
  Depth: number;
  Height: number;
}

export interface AddElementSlice {
  /** Currently selected element type — drives which form is shown. */
  addElementType: AddElementType;
  /**
   * Target storey expressId. `null` means "auto-pick the first storey
   * in the active model when the click lands". The panel's storey
   * select binds to this.
   */
  addElementStoreyId: number | null;
  /**
   * Target model id. `null` means "auto-pick the active model". Lets
   * the panel scope to a federated model when the user has multiples.
   */
  addElementModelId: string | null;
  addElementWallParams: AddElementWallParams;
  addElementSlabParams: AddElementSlabParams;
  addElementBeamParams: AddElementBeamParams;
  addElementColumnParams: AddElementColumnParams;

  setAddElementType: (t: AddElementType) => void;
  setAddElementStoreyId: (id: number | null) => void;
  setAddElementModelId: (id: string | null) => void;
  setAddElementWallParams: (p: Partial<AddElementWallParams>) => void;
  setAddElementSlabParams: (p: Partial<AddElementSlabParams>) => void;
  setAddElementBeamParams: (p: Partial<AddElementBeamParams>) => void;
  setAddElementColumnParams: (p: Partial<AddElementColumnParams>) => void;
}

const ADD_ELEMENT_DEFAULTS = {
  type: 'wall' as AddElementType,
  wall: { Thickness: 0.2, Height: 3, Length: 5 } as AddElementWallParams,
  slab: { Width: 5, Depth: 5, Thickness: 0.3 } as AddElementSlabParams,
  beam: { Width: 0.3, Height: 0.5, Length: 5 } as AddElementBeamParams,
  column: { Width: 0.4, Depth: 0.4, Height: 3 } as AddElementColumnParams,
};

export const createAddElementSlice: StateCreator<AddElementSlice, [], [], AddElementSlice> = (set) => ({
  addElementType: ADD_ELEMENT_DEFAULTS.type,
  addElementStoreyId: null,
  addElementModelId: null,
  addElementWallParams: { ...ADD_ELEMENT_DEFAULTS.wall },
  addElementSlabParams: { ...ADD_ELEMENT_DEFAULTS.slab },
  addElementBeamParams: { ...ADD_ELEMENT_DEFAULTS.beam },
  addElementColumnParams: { ...ADD_ELEMENT_DEFAULTS.column },

  setAddElementType: (addElementType) => set({ addElementType }),
  setAddElementStoreyId: (addElementStoreyId) => set({ addElementStoreyId }),
  setAddElementModelId: (addElementModelId) => set({ addElementModelId }),
  setAddElementWallParams: (p) =>
    set((s) => ({ addElementWallParams: { ...s.addElementWallParams, ...p } })),
  setAddElementSlabParams: (p) =>
    set((s) => ({ addElementSlabParams: { ...s.addElementSlabParams, ...p } })),
  setAddElementBeamParams: (p) =>
    set((s) => ({ addElementBeamParams: { ...s.addElementBeamParams, ...p } })),
  setAddElementColumnParams: (p) =>
    set((s) => ({ addElementColumnParams: { ...s.addElementColumnParams, ...p } })),
});
