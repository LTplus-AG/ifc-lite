/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JsonValue } from '../types.js';

export const WORKBENCH_LAYOUT_SCHEMA_VERSION = 1;

export type WorkbenchZoneId = 'left' | 'right' | 'bottom';
export type WorkbenchPanelId = string;

export interface WorkbenchPanelChrome {
  title?: string;
  icon?: string;
  accent?: string;
  hidden?: boolean;
}

export interface PersonalPanelDefinition {
  id: WorkbenchPanelId;
  title: string;
  description?: string;
  icon?: string;
  widget: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface FloatingPanelPlacement {
  panelId: WorkbenchPanelId;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkbenchModeSnapshot {
  zones: Record<WorkbenchZoneId, WorkbenchPanelId[]>;
  sizes: WorkbenchLayoutState['sizes'];
  collapsed: Record<WorkbenchZoneId, boolean>;
  activeTabs: Partial<Record<WorkbenchZoneId, WorkbenchPanelId>>;
  floating: FloatingPanelPlacement[];
  panelChrome: Record<WorkbenchPanelId, WorkbenchPanelChrome>;
}

export interface WorkbenchMode {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  snapshot: WorkbenchModeSnapshot;
}

export type UiAutomationTrigger =
  | { kind: 'model.loaded' }
  | { kind: 'selection.changed' }
  | { kind: 'panel.opened'; panelId: WorkbenchPanelId };

export type UiAutomationAction =
  | { kind: 'layout.openPanel'; panelId: WorkbenchPanelId }
  | { kind: 'layout.movePanel'; panelId: WorkbenchPanelId; zone: WorkbenchZoneId }
  | { kind: 'layout.collapse'; zone: WorkbenchZoneId; collapsed: boolean }
  | { kind: 'layout.applyMode'; modeId: string }
  | { kind: 'command.run'; commandId: string }
  | { kind: 'toast.show'; message: string };

export interface UiAutomation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: UiAutomationTrigger;
  when?: string;
  actions: UiAutomationAction[];
}

export interface WorkbenchHistoryEntry {
  id: string;
  label: string;
  createdAt: string;
  patchId?: string;
}

export interface WorkbenchLayoutState {
  schemaVersion: 1;
  /**
   * Built-in app layout this state was derived from. The viewer owns
   * the concrete default; this id lets future migrations/rebases know
   * what ancestor the user morphed.
   */
  baseLayoutId: string;
  zones: Record<WorkbenchZoneId, WorkbenchPanelId[]>;
  sizes: {
    horizontal: [number, number, number];
    bottomHeight: number;
  };
  collapsed: Record<WorkbenchZoneId, boolean>;
  activeTabs: Partial<Record<WorkbenchZoneId, WorkbenchPanelId>>;
  floating: FloatingPanelPlacement[];
  panelChrome: Record<WorkbenchPanelId, WorkbenchPanelChrome>;
  personalPanels: Record<WorkbenchPanelId, PersonalPanelDefinition>;
  workspaceModes: Record<string, WorkbenchMode>;
  automations: UiAutomation[];
  history: WorkbenchHistoryEntry[];
}

export interface LayoutMergeConflict {
  kind: 'panel_move' | 'zone_order' | 'split_resize' | 'panel_chrome' | 'personal_panel';
  key: string;
  ours: JsonValue;
  theirs: JsonValue;
  base?: JsonValue;
}

export interface LayoutMergeResult {
  merged: WorkbenchLayoutState;
  conflicts: LayoutMergeConflict[];
}

export type WorkbenchOperation =
  | { op: 'movePanel'; panelId: WorkbenchPanelId; toZone: WorkbenchZoneId; toIndex?: number }
  | { op: 'setPanelChrome'; panelId: WorkbenchPanelId; chrome: WorkbenchPanelChrome }
  | { op: 'addPersonalPanel'; panel: PersonalPanelDefinition; zone?: WorkbenchZoneId }
  | { op: 'removePanel'; panelId: WorkbenchPanelId }
  | { op: 'setFloatingPanel'; placement: FloatingPanelPlacement }
  | { op: 'removeFloatingPanel'; panelId: WorkbenchPanelId }
  | { op: 'saveWorkspaceMode'; mode: WorkbenchMode }
  | { op: 'deleteWorkspaceMode'; modeId: string }
  | { op: 'addAutomation'; automation: UiAutomation }
  | { op: 'updateAutomation'; automation: UiAutomation }
  | { op: 'deleteAutomation'; automationId: string }
  | { op: 'appendHistory'; entry: WorkbenchHistoryEntry }
  | { op: 'setHorizontalSizes'; sizes: [number, number, number] }
  | { op: 'setBottomHeight'; height: number }
  | { op: 'setCollapsed'; zone: WorkbenchZoneId; collapsed: boolean };

export interface WorkbenchPatch {
  id: string;
  author: 'user' | 'ai' | 'extension' | 'system';
  createdAt: string;
  operations: WorkbenchOperation[];
}
