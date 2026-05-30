/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  applyWorkbenchPatch,
  type WorkbenchLayoutState,
  type WorkbenchOperation,
  type WorkbenchPatch,
} from '@ifc-lite/extensions';
import type { PatchChangeSummary, PatchSimulationResult } from './types.js';

export function simulateWorkbenchPatch(
  base: WorkbenchLayoutState,
  patch: WorkbenchPatch,
): PatchSimulationResult {
  const warnings = validatePatch(base, patch);
  const next = applyWorkbenchPatch(base, patch);
  return {
    ok: warnings.length === 0,
    base,
    next,
    changes: patch.operations.map(describeOperation),
    warnings,
  };
}

export function describeOperation(operation: WorkbenchOperation): PatchChangeSummary {
  switch (operation.op) {
    case 'movePanel':
      return { operation: operation.op, label: 'Move panel', detail: `${operation.panelId} -> ${operation.toZone}` };
    case 'setPanelChrome':
      return { operation: operation.op, label: 'Update panel chrome', detail: operation.panelId };
    case 'addPersonalPanel':
      return { operation: operation.op, label: 'Add personal panel', detail: operation.panel.title };
    case 'removePanel':
      return { operation: operation.op, label: 'Remove panel', detail: operation.panelId };
    case 'setFloatingPanel':
      return { operation: operation.op, label: 'Float panel', detail: operation.placement.panelId };
    case 'removeFloatingPanel':
      return { operation: operation.op, label: 'Close floating panel', detail: operation.panelId };
    case 'saveWorkspaceMode':
      return { operation: operation.op, label: 'Save workspace mode', detail: operation.mode.name };
    case 'deleteWorkspaceMode':
      return { operation: operation.op, label: 'Delete workspace mode', detail: operation.modeId };
    case 'addAutomation':
    case 'updateAutomation':
      return { operation: operation.op, label: 'Configure automation', detail: operation.automation.name };
    case 'deleteAutomation':
      return { operation: operation.op, label: 'Delete automation', detail: operation.automationId };
    case 'appendAutomationRun':
      return { operation: operation.op, label: 'Append automation run log', detail: operation.entry.automationName };
    case 'appendHistory':
      return { operation: operation.op, label: 'Append history', detail: operation.entry.label };
    case 'setPanelConfig':
      return { operation: operation.op, label: 'Update built-in panel config', detail: operation.panelId };
    case 'setHorizontalSizes':
      return { operation: operation.op, label: 'Resize horizontal layout', detail: operation.sizes.join(' / ') };
    case 'setBottomHeight':
      return { operation: operation.op, label: 'Resize bottom dock', detail: `${operation.height}px` };
    case 'setCollapsed':
      return { operation: operation.op, label: operation.collapsed ? 'Collapse dock' : 'Expand dock', detail: operation.zone };
  }
  const _exhaustive: never = operation;
  throw new Error(`Unhandled workbench operation: ${JSON.stringify(_exhaustive)}`);
}

function validatePatch(base: WorkbenchLayoutState, patch: WorkbenchPatch): string[] {
  const warnings: string[] = [];
  if (patch.operations.length === 0) warnings.push('Patch contains no operations.');
  for (const operation of patch.operations) {
    if (operation.op === 'movePanel' || operation.op === 'removePanel') {
      if (!panelExists(base, operation.panelId)) warnings.push(`Panel is not currently registered: ${operation.panelId}`);
    }
    if (operation.op === 'setFloatingPanel' && operation.placement.width < 240) {
      warnings.push(`Floating panel ${operation.placement.panelId} is narrower than 240px.`);
    }
    if (operation.op === 'setBottomHeight' && operation.height < 120) {
      warnings.push('Bottom dock height is below the minimum 120px.');
    }
  }
  return warnings;
}

function panelExists(layout: WorkbenchLayoutState, panelId: string): boolean {
  return layout.zones.left.includes(panelId)
    || layout.zones.right.includes(panelId)
    || layout.zones.bottom.includes(panelId)
    || panelId in layout.personalPanels;
}
