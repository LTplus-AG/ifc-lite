/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import {
  createDefaultWorkbenchLayout,
  normalizeWorkbenchLayout,
  type PersonalPanelDefinition,
  type WorkbenchLayoutState,
  type WorkbenchPanelChrome,
  type WorkbenchPanelId,
  type WorkbenchZoneId,
} from '@ifc-lite/extensions';

export interface WorkbenchSlice {
  workbenchLayout: WorkbenchLayoutState;
  workbenchMorphMode: boolean;
  setWorkbenchMorphMode: (enabled: boolean) => void;
  setWorkbenchLayout: (layout: WorkbenchLayoutState | unknown) => void;
  resetWorkbenchLayout: () => void;
  openWorkbenchPanel: (panelId: WorkbenchPanelId) => void;
  setWorkbenchActiveTab: (zone: WorkbenchZoneId, panelId: WorkbenchPanelId | undefined) => void;
  moveWorkbenchPanel: (panelId: WorkbenchPanelId, toZone: WorkbenchZoneId, toIndex?: number) => void;
  setWorkbenchHorizontalSizes: (sizes: [number, number, number]) => void;
  setWorkbenchBottomHeight: (height: number) => void;
  setWorkbenchCollapsed: (zone: WorkbenchZoneId, collapsed: boolean) => void;
  setWorkbenchPanelChrome: (panelId: WorkbenchPanelId, chrome: WorkbenchPanelChrome) => void;
  addWorkbenchPersonalPanel: (panel: PersonalPanelDefinition, zone?: WorkbenchZoneId) => void;
}

export const createWorkbenchSlice: StateCreator<WorkbenchSlice, [], [], WorkbenchSlice> = (set, get) => ({
  workbenchLayout: createDefaultWorkbenchLayout(),
  workbenchMorphMode: false,

  setWorkbenchMorphMode: (workbenchMorphMode) => set({ workbenchMorphMode }),
  setWorkbenchLayout: (layout) => set({ workbenchLayout: normalizeWorkbenchLayout(layout) }),
  resetWorkbenchLayout: () => set({ workbenchLayout: createDefaultWorkbenchLayout() }),

  openWorkbenchPanel: (panelId) => {
    const layout = get().workbenchLayout;
    const zone = findPanelZone(layout, panelId);
    if (!zone) return;
    set({
      workbenchLayout: {
        ...layout,
        collapsed: { ...layout.collapsed, [zone]: false },
        activeTabs: { ...layout.activeTabs, [zone]: panelId },
      },
    });
  },

  setWorkbenchActiveTab: (zone, panelId) => {
    const layout = get().workbenchLayout;
    set({ workbenchLayout: { ...layout, activeTabs: { ...layout.activeTabs, [zone]: panelId } } });
  },

  moveWorkbenchPanel: (panelId, toZone, toIndex) => {
    const layout = get().workbenchLayout;
    const zones = {
      left: layout.zones.left.filter((id) => id !== panelId),
      right: layout.zones.right.filter((id) => id !== panelId),
      bottom: layout.zones.bottom.filter((id) => id !== panelId),
    };
    const next = [...zones[toZone]];
    const index = Math.min(Math.max(toIndex ?? next.length, 0), next.length);
    next.splice(index, 0, panelId);
    zones[toZone] = next;
    set({
      workbenchLayout: {
        ...layout,
        zones,
        collapsed: { ...layout.collapsed, [toZone]: false },
        activeTabs: { ...layout.activeTabs, [toZone]: panelId },
      },
    });
  },

  setWorkbenchHorizontalSizes: (horizontal) => {
    const layout = get().workbenchLayout;
    set({ workbenchLayout: { ...layout, sizes: { ...layout.sizes, horizontal } } });
  },

  setWorkbenchBottomHeight: (bottomHeight) => {
    const layout = get().workbenchLayout;
    set({ workbenchLayout: { ...layout, sizes: { ...layout.sizes, bottomHeight } } });
  },

  setWorkbenchCollapsed: (zone, collapsed) => {
    const layout = get().workbenchLayout;
    set({ workbenchLayout: { ...layout, collapsed: { ...layout.collapsed, [zone]: collapsed } } });
  },

  setWorkbenchPanelChrome: (panelId, chrome) => {
    const layout = get().workbenchLayout;
    set({
      workbenchLayout: {
        ...layout,
        panelChrome: {
          ...layout.panelChrome,
          [panelId]: { ...layout.panelChrome[panelId], ...chrome },
        },
      },
    });
  },

  addWorkbenchPersonalPanel: (panel, zone = 'right') => {
    const layout = get().workbenchLayout;
    const zones = {
      ...layout.zones,
      [zone]: layout.zones[zone].includes(panel.id) ? layout.zones[zone] : [...layout.zones[zone], panel.id],
    };
    set({
      workbenchLayout: {
        ...layout,
        zones,
        personalPanels: { ...layout.personalPanels, [panel.id]: panel },
        activeTabs: { ...layout.activeTabs, [zone]: panel.id },
        collapsed: { ...layout.collapsed, [zone]: false },
      },
    });
  },
});

function findPanelZone(layout: WorkbenchLayoutState, panelId: string): WorkbenchZoneId | undefined {
  if (layout.zones.left.includes(panelId)) return 'left';
  if (layout.zones.right.includes(panelId)) return 'right';
  if (layout.zones.bottom.includes(panelId)) return 'bottom';
  return undefined;
}
