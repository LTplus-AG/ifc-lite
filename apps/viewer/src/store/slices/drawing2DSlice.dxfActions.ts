/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StateCreator } from 'zustand';
import { DEFAULT_DXF_PLACEMENT } from '@ifc-lite/drawing-2d';
import { isDxfReferenceFrame } from '@/hooks/dxfReferencePlane';
import type { Drawing2DSlice, DxfUnderlayState } from './drawing2DSlice';
type Actions = Pick<Drawing2DSlice, 'addDxfUnderlay' | 'removeDxfUnderlay' | 'setDxfUnderlayVisible' | 'setDxfUnderlayVisible3D' | 'setDxfUnderlayOpacity' | 'toggleDxfUnderlayLayer' | 'updateDxfUnderlayPlacement' | 'setDxfUnderlayGeoreferenced' | 'clearDxfUnderlays'>;
export function createDxfUnderlayActions(set: Parameters<StateCreator<Drawing2DSlice>>[0]): Actions {
  return {
  // DXF Underlay Actions (issue #1782)
  addDxfUnderlay: (underlay, options) => {
    if (options?.referenceFrame && !isDxfReferenceFrame(options.referenceFrame)) throw new Error('Invalid DXF reference frame.');
    const id = `dxf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const layerVisibility: Record<string, boolean> = {};
    for (const layer of underlay.layers) layerVisibility[layer.name] = layer.visible;
    // Tri-state resolution (PR #1965 review, see the field doc above):
    // 'auto' -> undefined; anything else (including omitted) -> boolean,
    // defaulting to false. A caller that doesn't explicitly ask for 'auto'
    // can never accidentally create an auto entry.
    const georeferenced = options?.georeferenced === 'auto'
      ? undefined
      : (options?.georeferenced ?? false);
    const entry: DxfUnderlayState = {
      id,
      name: underlay.name,
      underlay,
      visible: true,
      visible3D: true,
      opacity: 1,
      layerVisibility,
      placement: { ...DEFAULT_DXF_PLACEMENT },
      georeferenced: options?.referenceFrame ? false : georeferenced,
      ...(options?.referenceFrame ? { referenceFrame: structuredClone(options.referenceFrame) } : {}),
    };
    set((state) => ({ dxfUnderlays: [...state.dxfUnderlays, entry] }));
    return id;
  },

  removeDxfUnderlay: (id) => set((state) => ({
    dxfUnderlays: state.dxfUnderlays.filter((u) => u.id !== id),
  })),

  setDxfUnderlayVisible: (id, visible) => set((state) => ({
    dxfUnderlays: state.dxfUnderlays.map((u) => (u.id === id ? { ...u, visible } : u)),
  })),

  setDxfUnderlayVisible3D: (id, visible3D) => set((state) => ({
    dxfUnderlays: state.dxfUnderlays.map((u) => (u.id === id ? { ...u, visible3D } : u)),
  })),

  setDxfUnderlayOpacity: (id, opacity) => set((state) => ({
    dxfUnderlays: state.dxfUnderlays.map((u) =>
      u.id === id && Number.isFinite(opacity) ? { ...u, opacity: Math.max(0, Math.min(1, opacity)) } : u
    ),
  })),

  toggleDxfUnderlayLayer: (id, layerName) => set((state) => ({
    dxfUnderlays: state.dxfUnderlays.map((u) => {
      if (u.id !== id) return u;
      const current = u.layerVisibility[layerName]
        ?? u.underlay.layers.find((l) => l.name === layerName)?.visible
        ?? true;
      return { ...u, layerVisibility: { ...u.layerVisibility, [layerName]: !current } };
    }),
  })),

  updateDxfUnderlayPlacement: (id, placement) => set((state) => ({
    dxfUnderlays: state.dxfUnderlays.map((u) =>
      u.id === id && Object.values(placement).every(Number.isFinite) && (placement.scale === undefined || placement.scale > 0) ? { ...u, placement: { ...u.placement, ...placement } } : u
    ),
  })),

  setDxfUnderlayGeoreferenced: (id, georeferenced) => set((state) => ({
    dxfUnderlays: state.dxfUnderlays.map((u) => (u.id === id ? { ...u, georeferenced } : u)),
  })),

  clearDxfUnderlays: () => set({ dxfUnderlays: [] }),

  };
}
