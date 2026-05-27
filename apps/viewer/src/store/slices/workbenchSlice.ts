/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import {
  createDefaultWorkbenchLayout,
  normalizeWorkbenchLayout,
  type PersonalPanelDefinition,
  type UiAutomation,
  type WorkbenchLayoutState,
  type WorkbenchMode,
  type WorkbenchModeSnapshot,
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
  updateWorkbenchPersonalPanel: (panel: PersonalPanelDefinition) => void;
  removeWorkbenchPersonalPanel: (panelId: WorkbenchPanelId) => void;
  saveWorkbenchMode: (name: string, description?: string) => WorkbenchMode;
  applyWorkbenchMode: (modeId: string) => void;
  deleteWorkbenchMode: (modeId: string) => void;
  upsertWorkbenchAutomation: (automation: UiAutomation) => void;
  deleteWorkbenchAutomation: (automationId: string) => void;
  appendWorkbenchHistory: (label: string, patchId?: string) => void;
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

  updateWorkbenchPersonalPanel: (panel) => {
    const layout = get().workbenchLayout;
    set({
      workbenchLayout: {
        ...layout,
        personalPanels: { ...layout.personalPanels, [panel.id]: panel },
        panelChrome: {
          ...layout.panelChrome,
          [panel.id]: { ...layout.panelChrome[panel.id], title: panel.title },
        },
      },
    });
  },

  removeWorkbenchPersonalPanel: (panelId) => {
    const layout = get().workbenchLayout;
    const { [panelId]: _removedPanel, ...personalPanels } = layout.personalPanels;
    const { [panelId]: _removedChrome, ...panelChrome } = layout.panelChrome;
    set({
      workbenchLayout: {
        ...layout,
        zones: {
          left: layout.zones.left.filter((id) => id !== panelId),
          right: layout.zones.right.filter((id) => id !== panelId),
          bottom: layout.zones.bottom.filter((id) => id !== panelId),
        },
        activeTabs: {
          left: layout.activeTabs.left === panelId ? undefined : layout.activeTabs.left,
          right: layout.activeTabs.right === panelId ? undefined : layout.activeTabs.right,
          bottom: layout.activeTabs.bottom === panelId ? undefined : layout.activeTabs.bottom,
        },
        panelChrome,
        personalPanels,
      },
    });
  },

  saveWorkbenchMode: (name, description) => {
    const layout = get().workbenchLayout;
    const now = new Date().toISOString();
    const id = `mode:${slugify(name)}:${Date.now().toString(36)}`;
    const mode: WorkbenchMode = {
      id,
      name,
      description,
      createdAt: now,
      updatedAt: now,
      snapshot: snapshotLayout(layout),
    };
    set({
      workbenchLayout: {
        ...layout,
        workspaceModes: { ...layout.workspaceModes, [id]: mode },
        history: [...layout.history, { id: crypto.randomUUID(), label: `Saved mode: ${name}`, createdAt: now }].slice(-50),
      },
    });
    return mode;
  },

  applyWorkbenchMode: (modeId) => {
    const layout = get().workbenchLayout;
    const mode = layout.workspaceModes[modeId];
    if (!mode) return;
    const now = new Date().toISOString();
    set({
      workbenchLayout: {
        ...layout,
        ...mode.snapshot,
        workspaceModes: layout.workspaceModes,
        automations: layout.automations,
        personalPanels: layout.personalPanels,
        history: [...layout.history, { id: crypto.randomUUID(), label: `Applied mode: ${mode.name}`, createdAt: now }].slice(-50),
      },
    });
  },

  deleteWorkbenchMode: (modeId) => {
    const layout = get().workbenchLayout;
    const { [modeId]: _deleted, ...workspaceModes } = layout.workspaceModes;
    set({ workbenchLayout: { ...layout, workspaceModes } });
  },

  upsertWorkbenchAutomation: (automation) => {
    const layout = get().workbenchLayout;
    set({
      workbenchLayout: {
        ...layout,
        automations: [
          ...layout.automations.filter((entry) => entry.id !== automation.id),
          automation,
        ],
      },
    });
  },

  deleteWorkbenchAutomation: (automationId) => {
    const layout = get().workbenchLayout;
    set({ workbenchLayout: { ...layout, automations: layout.automations.filter((entry) => entry.id !== automationId) } });
  },

  appendWorkbenchHistory: (label, patchId) => {
    const layout = get().workbenchLayout;
    set({
      workbenchLayout: {
        ...layout,
        history: [...layout.history, { id: crypto.randomUUID(), label, patchId, createdAt: new Date().toISOString() }].slice(-50),
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

function snapshotLayout(layout: WorkbenchLayoutState): WorkbenchModeSnapshot {
  return {
    zones: structuredClone(layout.zones),
    sizes: structuredClone(layout.sizes),
    collapsed: structuredClone(layout.collapsed),
    activeTabs: structuredClone(layout.activeTabs),
    floating: structuredClone(layout.floating),
    panelChrome: structuredClone(layout.panelChrome),
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
}
