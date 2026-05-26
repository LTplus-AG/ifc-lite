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
