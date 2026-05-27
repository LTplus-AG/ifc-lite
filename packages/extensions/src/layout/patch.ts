/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WorkbenchLayoutState, WorkbenchOperation, WorkbenchPatch, WorkbenchZoneId } from './types.js';

export function applyWorkbenchPatch(layout: WorkbenchLayoutState, patch: WorkbenchPatch): WorkbenchLayoutState {
  return patch.operations.reduce(applyWorkbenchOperation, cloneLayout(layout));
}

export function applyWorkbenchOperation(
  layout: WorkbenchLayoutState,
  operation: WorkbenchOperation,
): WorkbenchLayoutState {
  switch (operation.op) {
    case 'movePanel':
      return movePanel(layout, operation.panelId, operation.toZone, operation.toIndex);
    case 'setPanelChrome':
      return {
        ...layout,
        panelChrome: {
          ...layout.panelChrome,
          [operation.panelId]: { ...layout.panelChrome[operation.panelId], ...operation.chrome },
        },
      };
    case 'addPersonalPanel':
      return {
        ...movePanel(layout, operation.panel.id, operation.zone ?? 'right'),
        personalPanels: { ...layout.personalPanels, [operation.panel.id]: operation.panel },
      };
    case 'removePanel': {
      const { [operation.panelId]: _panel, ...personalPanels } = layout.personalPanels;
      const { [operation.panelId]: _chrome, ...panelChrome } = layout.panelChrome;
      return {
        ...layout,
        zones: removeFromZones(layout, operation.panelId),
        activeTabs: {
          left: layout.activeTabs.left === operation.panelId ? undefined : layout.activeTabs.left,
          right: layout.activeTabs.right === operation.panelId ? undefined : layout.activeTabs.right,
          bottom: layout.activeTabs.bottom === operation.panelId ? undefined : layout.activeTabs.bottom,
        },
        panelChrome,
        personalPanels,
      };
    }
    case 'setFloatingPanel':
      return {
        ...layout,
        floating: [
          ...layout.floating.filter((placement) => placement.panelId !== operation.placement.panelId),
          operation.placement,
        ],
      };
    case 'removeFloatingPanel':
      return {
        ...layout,
        floating: layout.floating.filter((placement) => placement.panelId !== operation.panelId),
      };
    case 'saveWorkspaceMode':
      return {
        ...layout,
        workspaceModes: { ...layout.workspaceModes, [operation.mode.id]: operation.mode },
      };
    case 'deleteWorkspaceMode': {
      const { [operation.modeId]: _mode, ...workspaceModes } = layout.workspaceModes;
      return { ...layout, workspaceModes };
    }
    case 'addAutomation':
    case 'updateAutomation':
      return {
        ...layout,
        automations: [
          ...layout.automations.filter((automation) => automation.id !== operation.automation.id),
          operation.automation,
        ],
      };
    case 'deleteAutomation':
      return {
        ...layout,
        automations: layout.automations.filter((automation) => automation.id !== operation.automationId),
      };
    case 'appendHistory':
      return {
        ...layout,
        history: [...layout.history.filter((entry) => entry.id !== operation.entry.id), operation.entry].slice(-50),
      };
    case 'setHorizontalSizes':
      return { ...layout, sizes: { ...layout.sizes, horizontal: operation.sizes } };
    case 'setBottomHeight':
      return { ...layout, sizes: { ...layout.sizes, bottomHeight: operation.height } };
    case 'setCollapsed':
      return { ...layout, collapsed: { ...layout.collapsed, [operation.zone]: operation.collapsed } };
  }
}

function movePanel(
  layout: WorkbenchLayoutState,
  panelId: string,
  toZone: WorkbenchZoneId,
  toIndex?: number,
): WorkbenchLayoutState {
  const zones = removeFromZones(layout, panelId);
  const next = [...zones[toZone]];
  const index = Math.min(Math.max(toIndex ?? next.length, 0), next.length);
  next.splice(index, 0, panelId);
  zones[toZone] = next;
  return {
    ...layout,
    zones,
    collapsed: { ...layout.collapsed, [toZone]: false },
    activeTabs: { ...layout.activeTabs, [toZone]: panelId },
  };
}

function removeFromZones(
  layout: WorkbenchLayoutState,
  panelId: string,
): WorkbenchLayoutState['zones'] {
  return {
    left: layout.zones.left.filter((id) => id !== panelId),
    right: layout.zones.right.filter((id) => id !== panelId),
    bottom: layout.zones.bottom.filter((id) => id !== panelId),
  };
}

function cloneLayout(layout: WorkbenchLayoutState): WorkbenchLayoutState {
  return structuredClone(layout);
}
