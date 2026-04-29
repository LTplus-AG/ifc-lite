/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Add-element tool state — drives the right-side AddElementPanel and
 * the viewport's click-to-place state machine. The actual STEP work
 * runs through `mutationSlice` actions (`addWall` / `addSlab` /
 * `addBeam` / `addColumn`); this slice holds:
 *
 *   - the panel form state (selected type, per-type dimensions,
 *     target storey, target federated model)
 *   - the in-progress click-placement state (pendingPoints,
 *     hoverPoint, slabMode for rectangle vs polygon)
 *
 * Defaults match the IfcCreator builders' construction-standard
 * conventions: wall thickness 0.2m, floor height 3m, slab 5×5×0.3m,
 * column 0.4×0.4×3m, beam 0.3×0.5×3m.
 */

import { type StateCreator } from 'zustand';

export type AddElementType = 'wall' | 'slab' | 'beam' | 'column';
export type AddElementSlabMode = 'rectangle' | 'polygon';

/** A single accumulated 3D click point in IFC Z-up storey-local space. */
export interface AddElementVec3 {
  x: number;
  y: number;
  z: number;
}

export interface AddElementWallParams {
  Thickness: number;
  Height: number;
}

export interface AddElementSlabParams {
  Width: number;
  Depth: number;
  Thickness: number;
}

export interface AddElementBeamParams {
  Width: number;
  Height: number;
}

export interface AddElementColumnParams {
  Width: number;
  Depth: number;
  Height: number;
}

export interface AddElementSlice {
  addElementType: AddElementType;
  /** Target storey expressId; `null` ⇒ auto-pick first storey on click. */
  addElementStoreyId: number | null;
  /** Target model id; `null` ⇒ auto-pick the active model on click. */
  addElementModelId: string | null;
  addElementWallParams: AddElementWallParams;
  addElementSlabParams: AddElementSlabParams;
  addElementBeamParams: AddElementBeamParams;
  addElementColumnParams: AddElementColumnParams;

  /** Rectangle (2 clicks) or polygon (N clicks + Enter to close). */
  addElementSlabMode: AddElementSlabMode;
  /** In-progress click points. Cleared on tool exit, type change, or Esc. */
  addElementPendingPoints: AddElementVec3[];
  /** Live preview point under the cursor (snap-aware). */
  addElementHoverPoint: AddElementVec3 | null;

  setAddElementType: (t: AddElementType) => void;
  setAddElementStoreyId: (id: number | null) => void;
  setAddElementModelId: (id: string | null) => void;
  setAddElementWallParams: (p: Partial<AddElementWallParams>) => void;
  setAddElementSlabParams: (p: Partial<AddElementSlabParams>) => void;
  setAddElementBeamParams: (p: Partial<AddElementBeamParams>) => void;
  setAddElementColumnParams: (p: Partial<AddElementColumnParams>) => void;
  setAddElementSlabMode: (m: AddElementSlabMode) => void;
  appendAddElementPendingPoint: (p: AddElementVec3) => void;
  setAddElementHoverPoint: (p: AddElementVec3 | null) => void;
  clearAddElementPending: () => void;
}

const ADD_ELEMENT_DEFAULTS = {
  type: 'wall' as AddElementType,
  wall: { Thickness: 0.2, Height: 3 } as AddElementWallParams,
  slab: { Width: 5, Depth: 5, Thickness: 0.3 } as AddElementSlabParams,
  beam: { Width: 0.3, Height: 0.5 } as AddElementBeamParams,
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
  addElementSlabMode: 'rectangle',
  addElementPendingPoints: [],
  addElementHoverPoint: null,

  setAddElementType: (addElementType) =>
    // Switching types resets the pending-click queue — a wall's start
    // doesn't make sense as a slab's first corner.
    set({ addElementType, addElementPendingPoints: [] }),
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
  setAddElementSlabMode: (addElementSlabMode) =>
    set({ addElementSlabMode, addElementPendingPoints: [] }),
  appendAddElementPendingPoint: (p) =>
    set((s) => ({ addElementPendingPoints: [...s.addElementPendingPoints, p] })),
  setAddElementHoverPoint: (addElementHoverPoint) => set({ addElementHoverPoint }),
  clearAddElementPending: () =>
    set({ addElementPendingPoints: [], addElementHoverPoint: null }),
});
