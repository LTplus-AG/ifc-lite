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

export type AddElementType =
  | 'wall'
  | 'slab'
  | 'beam'
  | 'column'
  | 'door'
  | 'window'
  | 'space'
  | 'roof'
  | 'plate'
  | 'member';
export type AddElementSlabMode = 'rectangle' | 'polygon';

/**
 * A single accumulated 3D click point in **renderer-frame** Y-up world
 * coordinates (the same space the camera projects from). The IFC
 * conversion happens at builder dispatch time so the live preview can
 * project each pending point to screen without needing to know the
 * target storey's elevation.
 */
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

export interface AddElementDoorParams {
  Width: number;
  Height: number;
  FrameThickness: number;
}

export interface AddElementWindowParams {
  Width: number;
  Height: number;
  FrameThickness: number;
}

export interface AddElementSpaceParams {
  Width: number;
  Depth: number;
  Height: number;
}

export interface AddElementRoofParams {
  Width: number;
  Depth: number;
  Thickness: number;
}

export interface AddElementPlateParams {
  Width: number;
  Depth: number;
  Thickness: number;
}

export interface AddElementMemberParams {
  Width: number;
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
  addElementDoorParams: AddElementDoorParams;
  addElementWindowParams: AddElementWindowParams;
  addElementSpaceParams: AddElementSpaceParams;
  addElementRoofParams: AddElementRoofParams;
  addElementPlateParams: AddElementPlateParams;
  addElementMemberParams: AddElementMemberParams;

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
  setAddElementDoorParams: (p: Partial<AddElementDoorParams>) => void;
  setAddElementWindowParams: (p: Partial<AddElementWindowParams>) => void;
  setAddElementSpaceParams: (p: Partial<AddElementSpaceParams>) => void;
  setAddElementRoofParams: (p: Partial<AddElementRoofParams>) => void;
  setAddElementPlateParams: (p: Partial<AddElementPlateParams>) => void;
  setAddElementMemberParams: (p: Partial<AddElementMemberParams>) => void;
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
  door: { Width: 0.9, Height: 2.1, FrameThickness: 0.05 } as AddElementDoorParams,
  window: { Width: 1.2, Height: 1.5, FrameThickness: 0.05 } as AddElementWindowParams,
  space: { Width: 4, Depth: 4, Height: 3 } as AddElementSpaceParams,
  roof: { Width: 8, Depth: 8, Thickness: 0.3 } as AddElementRoofParams,
  plate: { Width: 1, Depth: 1, Thickness: 0.02 } as AddElementPlateParams,
  member: { Width: 0.1, Height: 0.1 } as AddElementMemberParams,
};

export const createAddElementSlice: StateCreator<AddElementSlice, [], [], AddElementSlice> = (set) => ({
  addElementType: ADD_ELEMENT_DEFAULTS.type,
  addElementStoreyId: null,
  addElementModelId: null,
  addElementWallParams: { ...ADD_ELEMENT_DEFAULTS.wall },
  addElementSlabParams: { ...ADD_ELEMENT_DEFAULTS.slab },
  addElementBeamParams: { ...ADD_ELEMENT_DEFAULTS.beam },
  addElementColumnParams: { ...ADD_ELEMENT_DEFAULTS.column },
  addElementDoorParams: { ...ADD_ELEMENT_DEFAULTS.door },
  addElementWindowParams: { ...ADD_ELEMENT_DEFAULTS.window },
  addElementSpaceParams: { ...ADD_ELEMENT_DEFAULTS.space },
  addElementRoofParams: { ...ADD_ELEMENT_DEFAULTS.roof },
  addElementPlateParams: { ...ADD_ELEMENT_DEFAULTS.plate },
  addElementMemberParams: { ...ADD_ELEMENT_DEFAULTS.member },
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
  setAddElementDoorParams: (p) =>
    set((s) => ({ addElementDoorParams: { ...s.addElementDoorParams, ...p } })),
  setAddElementWindowParams: (p) =>
    set((s) => ({ addElementWindowParams: { ...s.addElementWindowParams, ...p } })),
  setAddElementSpaceParams: (p) =>
    set((s) => ({ addElementSpaceParams: { ...s.addElementSpaceParams, ...p } })),
  setAddElementRoofParams: (p) =>
    set((s) => ({ addElementRoofParams: { ...s.addElementRoofParams, ...p } })),
  setAddElementPlateParams: (p) =>
    set((s) => ({ addElementPlateParams: { ...s.addElementPlateParams, ...p } })),
  setAddElementMemberParams: (p) =>
    set((s) => ({ addElementMemberParams: { ...s.addElementMemberParams, ...p } })),
  setAddElementSlabMode: (addElementSlabMode) =>
    set({ addElementSlabMode, addElementPendingPoints: [] }),
  appendAddElementPendingPoint: (p) =>
    set((s) => ({ addElementPendingPoints: [...s.addElementPendingPoints, p] })),
  setAddElementHoverPoint: (addElementHoverPoint) => set({ addElementHoverPoint }),
  clearAddElementPending: () =>
    set({ addElementPendingPoints: [], addElementHoverPoint: null }),
});
